/** @fileoverview Regression tests for refund sequencing, recovery, and deadlines. */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import {sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import {EscrowRejectedError, type ContractEscrow, type EscrowRequest} from '../../packages/reliability/src/contract-lifecycle/ports';
import type {Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import {
  acceptTerms, act, agreeOutcome, complyAll, createKit, INSPECTORS, inspectorWhitelist, labReport,
  mediatorRuling, milestone, physicalDelivery, runUntil, settleTicks, terminate, type Kit,
} from './contract-kit';
import {PaperContractEscrow} from './contract-paper-escrow';
import {ContractService} from './contract-service';

const FILE = 'contract regression test file';

function digital(kit: Kit, remedy?: Remedy, count = 1): string {
  return kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable', buyerId: kit.buyerId, sellerId: kit.sellerId, remedy,
    milestones: Array.from({length: count}, (value, index) => ({
      title: `file ${index}`, amountAtomic: '5000000', deliverable: {expectedSha256: sha256Hex(FILE)},
    })),
  }, kit.buyerId).id;
}

async function inspectingDigital(kit: Kit, remedy?: Remedy, content = FILE): Promise<string> {
  const id = digital(kit, remedy);
  acceptTerms(kit, id);
  await runUntil(kit, id, 'funded');
  act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content}]});
  await runUntil(kit, id, 'in_inspection');
  return id;
}

async function disputedPhysical(kit: Kit, remedy?: Remedy, report = false): Promise<string> {
  const id = kit.service.lifecycle.createContract({
    templateId: 'physical-objective-spec', buyerId: kit.buyerId, sellerId: kit.sellerId, remedy,
    inspectorWhitelist: inspectorWhitelist(kit), judgeInspectorId: INSPECTORS.judge,
    milestones: [{title: 'goods', amountAtomic: '5000000', deliverable: {
      specDocumentSha256: sha256Hex('spec'), description: 'goods', quantity: 1, unit: 'kg',
    }}],
  }, kit.buyerId).id;
  acceptTerms(kit, id);
  await runUntil(kit, id, 'funded');
  const mId = milestone(kit, id).id;
  act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: physicalDelivery(kit, id, mId)});
  await runUntil(kit, id, 'in_inspection');
  act(kit, id, kit.buyerId, 'dispute', {
    milestoneId: mId, evidence: report ? [labReport(kit, id, mId, 'FAIL')] : [{type: 'note', content: 'wrong goods'}],
  });
  await runUntil(kit, id, 'tier_1_negotiation');
  return id;
}

/** Add a fault at the external write boundary. All other calls use the real paper rail. */
function withFault(kit: Kit, reject: (request: EscrowRequest) => boolean): Kit {
  const inner = kit.service.escrow;
  const escrow: ContractEscrow = {
    mode: 'paper',
    execute: async (request) => {
      if (reject(request)) throw new EscrowRejectedError('injected request rejection');
      return inner.execute(request);
    },
    inspect: (request) => inner.inspect(request),
    status: (ref, terms) => inner.status(ref, terms),
  };
  return {...kit, service: new ContractService(kit.store, {config: kit.service.config, clock: kit.clock, escrow})};
}

describe('refund sequencing', () => {
  for (const action of ['concession', 'termination'] as const) {
    for (const state of ['funded', 'in_inspection'] as const) {
      test(`${action} from ${state} requests a refund before seller authorization`, async () => {
        const kit = createKit();
        try {
          const id = state === 'in_inspection' ? await inspectingDigital(kit) : digital(kit);
          if (state === 'funded') {
            acceptTerms(kit, id);
            await runUntil(kit, id, 'funded');
          }
          const mId = milestone(kit, id).id;
          if (action === 'concession') act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: mId});
          else terminate(kit, id, mId);
          expect(kit.service.lifecycle.operations(id).filter((operation) => operation.kind === 'authorize_refund')).toHaveLength(0);
          await kit.service.tick();
          expect(kit.service.lifecycle.operations(id).filter((operation) => operation.kind === 'authorize_refund')).toHaveLength(0);
          await runUntil(kit, id, 'refunded');
          const ref = milestone(kit, id).tranches[0]!.escrowRef!;
          const kinds = (kit.service.escrow as PaperContractEscrow).transactionLog(ref).map((tx) => tx.kind);
          expect(kinds.indexOf('SetRefundRequested')).toBeLessThan(kinds.indexOf('AuthorizeRefund'));
          expect(milestone(kit, id).tranches[0]!.chain.paidToBuyerAtomic).toBe('5000000');
        } finally {
          kit.close();
        }
      });
    }
  }

  test('partial funding refunds the locked escrow through the legal states', async () => {
    const base = createKit();
    let blockedRef: string|null = null;
    const kit = withFault(base, (request) => request.kind === 'lock_funds' && request.ref === blockedRef);
    try {
      const id = digital(kit, {type: 'partial_release', sellerShareBps: 7000});
      acceptTerms(kit, id);
      await kit.service.lifecycle.processOperations();
      blockedRef = milestone(kit, id).tranches[1]!.escrowRef;
      await settleTicks(kit);
      expect(milestone(kit, id).state).toBe('awaiting_funding');
      expect(milestone(kit, id).tranches[0]!.chain.onChainState).toBe('FundsLocked');
      kit.clock.set(milestone(kit, id).deadlines!.payByTime);
      await runUntil(kit, id, 'expired');
      expect(milestone(kit, id).closedReason).toBe('partially_funded_unwound');
      expect(milestone(kit, id).tranches[0]!.chain.paidToBuyerAtomic).toBe('3500000');
      expect(kit.service.lifecycle.operations(id).find((operation) => operation.kind === 'authorize_refund')?.status).toBe('done');
    } finally {
      kit.close();
    }
  });

  test('a refund instruction after unlockTime is rejected before any escrow write', async () => {
    const kit = createKit();
    try {
      const id = await inspectingDigital(kit);
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime);
      const count = kit.service.lifecycle.operations(id).length;
      expect(() => act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, id).id})).toThrow(ContractError);
      expect(() => terminate(kit, id, milestone(kit, id).id)).toThrow(ContractError);
      expect(kit.service.lifecycle.operations(id)).toHaveLength(count);
      expect(milestone(kit, id).pending).toBeNull();
    } finally {
      kit.close();
    }
  });

  test('a refund request that never confirms records the completed automatic payment', async () => {
    const base = createKit();
    const inner = base.service.escrow;
    const escrow: ContractEscrow = {
      mode: 'paper',
      execute: (request) => request.kind === 'request_refund' ? Promise.resolve({ref: request.ref!}) : inner.execute(request),
      inspect: (request) => inner.inspect(request), status: (ref, terms) => inner.status(ref, terms),
    };
    const kit = {...base, service: new ContractService(base.store, {config: base.service.config, clock: base.clock, escrow})};
    try {
      const id = await inspectingDigital(kit);
      act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, id).id});
      await kit.service.tick();
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
      await runUntil(kit, id, 'settled');
      expect(milestone(kit, id).closedReason).toBe('refund_lost_to_release');
      expect(milestone(kit, id).tranches[0]!.chain.paidToSellerAtomic).toBe('5000000');
      expect(kit.store.getOutcome(`${id}/m0`)?.state).toBe('successful');
    } finally {
      kit.close();
    }
  });
});

describe('separate escrow states', () => {
  test('one rejected dispute still settles the disputed escrow and records the payment shortfall', async () => {
    const base = createKit();
    let blockedRef: string|null = null;
    const kit = withFault(base, (request) => request.kind === 'request_refund' && request.ref === blockedRef);
    try {
      const id = await inspectingDigital(kit, {type: 'partial_release', sellerShareBps: 7000}, 'wrong file');
      blockedRef = milestone(kit, id).tranches[1]!.escrowRef;
      const mId = milestone(kit, id).id;
      act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'hash mismatch'}]});
      await kit.service.lifecycle.processOperations();
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
      await runUntil(kit, id, 'resolved');
      expect(milestone(kit, id).dispute.obligations).toHaveLength(1);
      expect(milestone(kit, id).dispute.obligations[0]!.trancheIds).toEqual([milestone(kit, id).tranches[0]!.id]);
      complyAll(kit, id);
      await runUntil(kit, id, 'settled');
      expect(milestone(kit, id).closedReason).toBe('ruling_partially_executed');
      expect(milestone(kit, id).tranches.map((tranche) => tranche.chain.onChainState)).toEqual(['Withdrawn', 'Withdrawn']);
      const evidence = kit.store.getOutcome(`${id}/m0`)!.evidence as {[key: string]: unknown};
      expect([evidence.refundedToBuyerAtomic, evidence.releasedToSellerAtomic]).toEqual(['0', '5000000']);
      expect(kit.service.lifecycle.audit(id).some((row) => row.event === 'settlement_shortfall')).toBe(true);
    } finally {
      kit.close();
    }
  });
});

describe('delivery recovery and repeated evidence', () => {
  test('a restart after automatic payment recovers delivery time and funds the next milestone once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'contract-delivery-recovery-'));
    const databasePath = join(directory, 'agent.sqlite');
    let kit = createKit({databasePath});
    try {
      const id = digital(kit, undefined, 2);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}]});
      const deliveredAt = kit.clock.now() + kit.service.config.paperEscrow.confirmationDelayMs;
      await kit.service.lifecycle.processOperations();
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
      const {clock, keys} = kit;
      kit.close();
      kit = createKit({databasePath, clock, keys, reuseParties: true});
      await runUntil(kit, id, 'settled');
      expect(milestone(kit, id).deliveredAt).toBe(deliveredAt);
      expect(kit.store.getOutcome(`${id}/m0`)?.state).toBe('successful');
      expect(kit.service.lifecycle.operations(id).filter((operation) => operation.milestoneId === milestone(kit, id, 1).id && operation.kind === 'create_terms')).toHaveLength(1);
      const events = kit.store.listReliabilityEventsForTransaction(`${id}/m0`).length;
      await settleTicks(kit);
      expect(kit.store.listReliabilityEventsForTransaction(`${id}/m0`)).toHaveLength(events);
      expect(kit.store.verifyContractAuditChain()).toBeNull();
    } finally {
      kit.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('identical evidence reuses the failed operation and preserves inspection before retry', async () => {
    const base = createKit();
    let rejected = false;
    const kit = withFault(base, (request) => {
      if (request.kind !== 'submit_result' || rejected) return false;
      rejected = true;
      return true;
    });
    try {
      const id = digital(kit);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      const deliver = () => act(kit, id, kit.sellerId, 'deliver', {
        milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}],
      });
      deliver();
      await kit.service.tick();
      const before = kit.service.lifecycle.operations(id).find((operation) => operation.kind === 'submit_result')!;
      expect(before.status).toBe('failed');
      expect(deliver).not.toThrow();
      const retry = kit.service.lifecycle.operations(id).find((operation) => operation.kind === 'submit_result')!;
      expect([retry.id, retry.attempts, retry.status, retry.lastError]).toEqual([before.id, before.attempts, 'pending', null]);
      await runUntil(kit, id, 'in_inspection');
      const after = kit.service.lifecycle.operations(id).filter((operation) => operation.kind === 'submit_result');
      expect(after).toHaveLength(1);
      expect(after[0]!.attempts).toBe(2);
      expect(kit.service.lifecycle.audit(id).some((row) => row.event === 'escrow_operation_retry_requested')).toBe(true);
      const paper = base.service.escrow as PaperContractEscrow;
      expect(paper.transactionLog(milestone(kit, id).tranches[0]!.escrowRef!).filter((tx) => tx.kind === 'SubmitResult')).toHaveLength(1);
    } finally {
      kit.close();
    }
  });
});

interface DeadlineAction {
  id: string;
  deadline: number;
  perform: () => unknown;
}

async function deadlineAction(kit: Kit, name: string): Promise<DeadlineAction> {
  if (name === 'accept redo' || name === 'reject redo') {
    const id = await inspectingDigital(kit, {type: 'redo_or_replace'}, 'wrong file');
    const mId = milestone(kit, id).id;
    act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'hash mismatch'}]});
    await runUntil(kit, id, 'redo_pending');
    act(kit, id, kit.sellerId, 'redeliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]});
    await runUntil(kit, id, 'redo_inspection');
    return {id, deadline: milestone(kit, id).dispute.followUpDeadline!, perform: () =>
      act(kit, id, kit.buyerId, name === 'accept redo' ? 'accept_redo' : 'reject_redo', {milestoneId: mId})};
  }
  const returning = name === 'return shipment' || name === 'return receipt';
  const id = await disputedPhysical(kit, returning ? {type: 'full_refund_with_return'} : undefined, returning);
  const mId = milestone(kit, id).id;
  if (name === 'Tier 1 agreement') return {id, deadline: milestone(kit, id).dispute.tierDeadline!,
    perform: () => agreeOutcome(kit, id, mId, 'full_refund')};
  if (name === 'Tier 1 escalation') return {id, deadline: milestone(kit, id).dispute.tierDeadline!,
    perform: () => act(kit, id, kit.sellerId, 'escalate', {milestoneId: mId})};
  act(kit, id, kit.sellerId, 'escalate', {milestoneId: mId});
  if (returning) return {id, deadline: milestone(kit, id).dispute.followUpDeadline!, perform: () =>
    name === 'return shipment' ?
      act(kit, id, kit.buyerId, 'record_return_shipment', {milestoneId: mId, evidence: [{type: 'return_tracking', content: 'tracking'}]}) :
      act(kit, id, kit.sellerId, 'confirm_return_received', {milestoneId: mId})};
  if (name === 'judge report') return {id, deadline: milestone(kit, id).dispute.tierDeadline!, perform: () =>
    act(kit, id, kit.buyerId, 'submit_judge_report', {milestoneId: mId, evidence: [labReport(kit, id, mId, 'FAIL')]})};
  kit.clock.set(milestone(kit, id).dispute.tierDeadline!);
  await runUntil(kit, id, 'tier_3_mediation');
  const ruling = {winner: 'buyer' as const, reason: 'mediator decision'};
  return {id, deadline: milestone(kit, id).dispute.tierDeadline!, perform: () =>
    kit.service.lifecycle.submitMediatorRuling(id, mId, ruling, mediatorRuling(kit, id, mId, ruling))};
}

describe('action deadlines without a scheduler pass', () => {
  for (const name of ['Tier 1 agreement', 'Tier 1 escalation', 'judge report', 'mediator ruling', 'return shipment', 'return receipt', 'accept redo', 'reject redo']) {
    for (const offset of [-1, 0, 1]) {
      test(`${name} at deadline ${offset >= 0 ? '+' : ''}${offset} ms`, async () => {
        const kit = createKit();
        try {
          const action = await deadlineAction(kit, name);
          kit.clock.set(action.deadline + offset);
          const before = kit.service.lifecycle.getContract(action.id);
          const auditCount = kit.service.lifecycle.audit(action.id).length;
          if (offset < 0) expect(action.perform).not.toThrow();
          else {
            try {
              action.perform();
              throw new Error('the expired action was accepted');
            } catch (error) {
              expect(error).toBeInstanceOf(ContractError);
              expect((error as ContractError).code).toBe('deadline_passed');
            }
            expect(kit.service.lifecycle.getContract(action.id)).toEqual(before);
            expect(kit.service.lifecycle.audit(action.id)).toHaveLength(auditCount);
          }
        } finally {
          kit.close();
        }
      });
    }
  }
});
