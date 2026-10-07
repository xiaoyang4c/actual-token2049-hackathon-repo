/**
 * @fileoverview Contract lifecycle scenarios on the paper escrow, with the
 * production template windows (72 h inspection and so on). Time moves only
 * through the manual clock.
 */

import {describe, expect, test} from 'bun:test';
import {createHash, randomUUID} from 'node:crypto';
import {partyActionBytes} from '../../packages/reliability/src/contract-lifecycle/engine';
import {ContractError} from '../../packages/reliability/src/contract-lifecycle/errors';
import {milestoneTransactionId} from '../../packages/reliability/src/contract-lifecycle/settlement';
import {IllegalTransitionError} from '../../packages/reliability/src/contract-lifecycle/transitions';
import type {Remedy} from '../../packages/reliability/src/contract-lifecycle/types';
import type {Outcome} from '../../packages/reliability/src/types';
import {
  acceptTerms, act, agreeOutcome, complyAll, createKit, envOf, INSPECTORS, inspectorWhitelist, labReport,
  mediatorRuling, milestone, physicalDelivery, runUntil, settleTicks, sign, terminate, type Kit,
} from './contract-kit';
import {PaperContractEscrow} from './contract-paper-escrow';

const HOUR = 3_600_000;
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FILE = 'sku,price_usd\nA-100,12.50\nA-101,"7,25"\n';

function expectCode(work: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    work();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ContractError);
  expect((thrown as ContractError).code).toBe(code);
}

function digital(kit: Kit, remedy?: Remedy, amountAtomic = '25000000') {
  return kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title: 'Price dataset', amountAtomic, deliverable: {expectedSha256: sha(FILE), fileName: 'prices.csv'}}],
    remedy,
  }, kit.buyerId);
}

async function fundedDigital(kit: Kit, remedy?: Remedy) {
  const contract = digital(kit, remedy);
  acceptTerms(kit, contract.id);
  await runUntil(kit, contract.id, 'funded');
  return {id: contract.id, mId: contract.milestones[0]?.id ?? ''};
}

async function inspectingDigital(kit: Kit, content = FILE, remedy?: Remedy) {
  const deal = await fundedDigital(kit, remedy);
  act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: [{type: 'content_file', content, mediaType: 'text/csv'}]});
  await runUntil(kit, deal.id, 'in_inspection');
  return deal;
}

async function fundedPhysical(kit: Kit, remedy?: Remedy) {
  const contract = kit.service.lifecycle.createContract({
    templateId: 'physical-objective-spec',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{
      title: '20 bags green coffee, Grade A',
      amountAtomic: '10000000',
      deliverable: {specDocumentSha256: sha('arabica, moisture 12.5% or less, Grade A'), description: 'Green arabica', quantity: 1200, unit: 'kg', grade: 'A'},
    }],
    remedy,
    inspectorWhitelist: inspectorWhitelist(kit),
    judgeInspectorId: INSPECTORS.judge,
  }, kit.sellerId);
  acceptTerms(kit, contract.id);
  await runUntil(kit, contract.id, 'funded');
  return {id: contract.id, mId: contract.milestones[0]?.id ?? ''};
}

async function disputedPhysical(kit: Kit, remedy: Remedy|undefined, evidence: 'judge_fail'|'note') {
  const deal = await fundedPhysical(kit, remedy);
  act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
  await runUntil(kit, deal.id, 'in_inspection');
  act(kit, deal.id, kit.buyerId, 'dispute', {
    milestoneId: deal.mId,
    evidence: evidence === 'judge_fail' ? [labReport(kit, deal.id, deal.mId, 'FAIL')] : [{type: 'note', content: 'wrong grade'}],
  });
  await runUntil(kit, deal.id, 'tier_1_negotiation');
  return deal;
}

/** Wait for the ruling, let every obligated party comply, wait for settlement. */
async function settleRuling(kit: Kit, contractId: string): Promise<void> {
  await runUntil(kit, contractId, 'resolved');
  complyAll(kit, contractId);
  await runUntil(kit, contractId, 'settled');
}

/** The published reliability outcome of a milestone, with its settlement record. */
function outcome(kit: Kit, contractId: string, index = 0): Outcome&{record: {[key: string]: unknown}} {
  const contract = kit.service.lifecycle.getContract(contractId);
  const target = contract.milestones[index];
  if (!target) throw new Error('missing milestone');
  const saved = kit.store.getOutcome(milestoneTransactionId(contract, target));
  if (!saved) throw new Error('no published outcome');
  return {...saved, record: saved.evidence as {[key: string]: unknown}};
}

describe('template 1: digital, machine-checkable', () => {
  test('auto-releases exactly at the inspection cutoff and settles only after the withdraw confirms', async () => {
    const kit = createKit();
    const {id} = await inspectingDigital(kit);
    const current = milestone(kit, id);
    const deadlines = current.deadlines!;
    expect(current.inspectionCutoffAt).toBe(current.deliveredAt! + 72 * HOUR);

    kit.clock.set(current.inspectionCutoffAt! - 1);
    await kit.service.tick();
    expect(milestone(kit, id).state).toBe('in_inspection');

    kit.clock.set(current.inspectionCutoffAt!);
    await kit.service.tick();
    expect(milestone(kit, id).state).toBe('auto_released');
    expect(milestone(kit, id).tranches[0]?.chain.onChainState).toBe('ResultSubmitted');
    expect(outcome(kit, id).state).toBe('pending');

    kit.clock.set(deadlines.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs - 1);
    await kit.service.tick();
    expect(milestone(kit, id).state).toBe('auto_released');

    kit.clock.set(deadlines.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
    await runUntil(kit, id, 'settled');
    const published = outcome(kit, id);
    expect(published.state).toBe('successful');
    expect(published.verificationConfidence).toBe(0.4);
    expect(published.record.outcome).toBe('AUTO_RELEASED');
    expect(published.record.mode).toBe('paper');
    expect(published.record.custodyModel).toBe('platform_custodial_test_only');
    expect(published.record.releasedToSellerAtomic).toBe('25000000');
    expect(published.record.collectionTxHash).toBeNull();
    expect((published.record.settlementTxHashes as string[]).every((hash) => hash.startsWith('paper-'))).toBe(true);
    const events = kit.store.listReliabilityEventsForTransaction(milestoneTransactionId(kit.service.lifecycle.getContract(id), milestone(kit, id)));
    expect(events.map((event) => `${event.role}:${event.outcome}:${event.category}`).sort()).toEqual(['buyer:success:delivery', 'seller:success:delivery']);
    kit.close();
  });

  test('buyer acceptance is off-chain and recorded; funds still wait for unlockTime', async () => {
    const kit = createKit();
    const {id, mId} = await inspectingDigital(kit);
    kit.clock.advance(2 * HOUR);
    act(kit, id, kit.buyerId, 'accept', {milestoneId: mId});
    expect(milestone(kit, id).state).toBe('accepted_pending_release');
    await settleTicks(kit);
    expect(milestone(kit, id).state).toBe('accepted_pending_release');
    kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
    await runUntil(kit, id, 'settled');
    const published = outcome(kit, id);
    expect(published.record.outcome).toBe('ACCEPTED');
    expect(published.record.buyerAcceptedAt).toBe(new Date(milestone(kit, id).buyerAcceptedAt!).toISOString());
    expect(published.verificationConfidence).toBe(0.7);
    kit.close();
  });

  test('a matching hash: the code judge rules for the seller; the buyer must authorize the release', async () => {
    const kit = createKit();
    const {id, mId} = await inspectingDigital(kit);
    act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'I think the file is wrong'}]});
    await runUntil(kit, id, 'resolved');
    expect(milestone(kit, id).dispute.obligations.map((item) => [item.party, item.action])).toEqual([['buyer', 'authorize_withdrawal']]);
    complyAll(kit, id);
    await runUntil(kit, id, 'settled');
    const published = outcome(kit, id);
    expect([published.state, published.record.disputeTierReached, published.record.disputeWinner]).toEqual(['successful', 2, 'seller']);
    expect(published.record.decidedBy).toBe('code:content_hash_match');
    expect(published.verificationConfidence).toBe(0.95);
    kit.close();
  });

  test('a wrong file: the code judge rules for the buyer; failed with seller fault', async () => {
    const kit = createKit();
    const {id, mId} = await inspectingDigital(kit, 'something else');
    act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'hash mismatch'}]});
    await settleRuling(kit, id);
    const published = outcome(kit, id);
    expect([published.state, published.fault, published.record.refundedToBuyerAtomic]).toEqual(['failed', 'seller', '25000000']);
    kit.close();
  });
});

describe('remedy: redo_or_replace (one retry, then refund)', () => {
  async function redoPending() {
    const kit = createKit();
    const deal = await inspectingDigital(kit, 'broken v1', {type: 'redo_or_replace'});
    act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [{type: 'note', content: 'hash mismatch'}]});
    await runUntil(kit, deal.id, 'redo_pending');
    return {kit, ...deal};
  }

  test('the seller redelivers and the buyer accepts: released at once', async () => {
    const {kit, id, mId} = await redoPending();
    act(kit, id, kit.sellerId, 'redeliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]});
    await runUntil(kit, id, 'redo_inspection');
    act(kit, id, kit.buyerId, 'accept_redo', {milestoneId: mId});
    await runUntil(kit, id, 'settled');
    expect(outcome(kit, id).record.releasedToSellerAtomic).toBe('25000000');
    expect(outcome(kit, id).record.rulingExecutedBy).toBe('parties');
    kit.close();
  });

  test('the buyer rejects the redo: refund, no second retry', async () => {
    const {kit, id, mId} = await redoPending();
    act(kit, id, kit.sellerId, 'redeliver', {milestoneId: mId, evidence: [{type: 'content_file', content: 'broken v2'}]});
    await runUntil(kit, id, 'redo_inspection');
    act(kit, id, kit.buyerId, 'reject_redo', {milestoneId: mId});
    await settleRuling(kit, id);
    expect(outcome(kit, id).record.refundedToBuyerAtomic).toBe('25000000');
    kit.close();
  });

  test('no redelivery: refund at the redo deadline', async () => {
    const {kit, id} = await redoPending();
    kit.clock.set(milestone(kit, id).dispute.followUpDeadline!);
    await settleRuling(kit, id);
    expect(outcome(kit, id).record.refundedToBuyerAtomic).toBe('25000000');
    kit.close();
  });

  test('the buyer stays silent twice: the ignored ruling is recorded, then the custodial fallback releases', async () => {
    const {kit, id, mId} = await redoPending();
    act(kit, id, kit.sellerId, 'redeliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]});
    await runUntil(kit, id, 'redo_inspection');
    kit.clock.set(milestone(kit, id).dispute.followUpDeadline!);
    await runUntil(kit, id, 'resolved');
    const obligations = milestone(kit, id).dispute.obligations;
    expect(obligations.map((item) => item.party)).toEqual(['buyer']);
    kit.clock.set(obligations[0]!.dueAt - 1);
    await kit.service.tick();
    expect(milestone(kit, id).state).toBe('resolved');
    expect(milestone(kit, id).tranches[0]?.chain.onChainState).toBe('Disputed');
    kit.clock.set(obligations[0]!.dueAt);
    await runUntil(kit, id, 'settled');
    const audit = kit.service.lifecycle.audit(id).map((row) => row.event);
    expect(audit.indexOf('ruling_ignored')).toBeLessThan(audit.indexOf('ruling_executed_by_custodian'));
    const published = outcome(kit, id);
    expect(published.record.rulingExecutedBy).toBe('platform_custodial_fallback');
    expect((published.record.rulingCompliance as {buyer: {ignored: boolean}}).buyer.ignored).toBe(true);
    const contract = kit.service.lifecycle.getContract(id);
    const penalty = kit.store.listReliabilityEventsForTransaction(milestoneTransactionId(contract, milestone(kit, id)))
      .filter((event) => event.category === 'dispute');
    expect(penalty.map((event) => [event.entityId, event.role, event.outcome])).toEqual([[kit.buyerId, 'buyer', 'failure']]);
    kit.close();
  });
});

describe('template 3: physical goods, inspector judge', () => {
  test('DEMO: a judge lab report contradicts the seller certificate; Tier 2 decides; partial release runs', async () => {
    const kit = createKit();
    const deal = await fundedPhysical(kit);
    expect(milestone(kit, deal.id).tranches.map((item) => [item.role, item.amountAtomic])).toEqual([['core', '7000000'], ['holdback', '3000000']]);
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
    await runUntil(kit, deal.id, 'in_inspection');
    kit.clock.advance(30 * HOUR);
    act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [labReport(kit, deal.id, deal.mId, 'FAIL'), {type: 'arrival_photo', content: 'SYNTHETIC-PHOTO: wet bags'}]});
    await runUntil(kit, deal.id, 'tier_1_negotiation');
    expect(outcome(kit, deal.id).state).toBe('disputed');
    act(kit, deal.id, kit.sellerId, 'escalate', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'resolved');
    expect(milestone(kit, deal.id).dispute.obligations.map((item) => [item.party, item.action])).toEqual(
      [['buyer', 'authorize_withdrawal'], ['seller', 'authorize_refund']],
    );
    complyAll(kit, deal.id);
    await runUntil(kit, deal.id, 'settled');
    const published = outcome(kit, deal.id);
    expect(published.record.decidedBy).toBe(`inspector:${INSPECTORS.judge}`);
    expect([published.state, published.fault, published.record.releasedToSellerAtomic, published.record.refundedToBuyerAtomic])
      .toEqual(['failed', 'seller', '7000000', '3000000']);
    expect(published.verificationMethod).toBe('manual-review');
    kit.close();
  });

  test('Tier 1: both parties sign core_only; their signatures carry it out at once, free of fees', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, undefined, 'note');
    expectCode(() => kit.service.lifecycle.agreeOutcome(deal.id, deal.mId, 'core_only', 'aa'.repeat(64), 'bb'.repeat(64)), 'bad_signature');
    agreeOutcome(kit, deal.id, deal.mId, 'core_only');
    await runUntil(kit, deal.id, 'settled');
    const published = outcome(kit, deal.id);
    expect([published.record.disputeTierReached, published.record.disputeWinner, published.record.disputeFeeAtomic]).toEqual([1, 'split', '0']);
    expect(published.record.rulingExecutedBy).toBe('parties');
    kit.close();
  });

  test('core_only is impossible for a single-escrow milestone', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, {type: 'full_refund_no_return'}, 'note');
    expectCode(() => agreeOutcome(kit, deal.id, deal.mId, 'core_only'), 'outcome_not_allowed');
    kit.close();
  });

  test('Tier 3: a report not signed by the named judge; Tier 2 times out; the mediator rules; the loser pays', async () => {
    const kit = createKit();
    const deal = await fundedPhysical(kit);
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
    await runUntil(kit, deal.id, 'in_inspection');
    act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [labReport(kit, deal.id, deal.mId, 'FAIL', 'sellerLab')]});
    await runUntil(kit, deal.id, 'tier_1_negotiation');
    act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
    await settleTicks(kit);
    expect(milestone(kit, deal.id).state).toBe('tier_2_evidence_rule');
    expectCode(() => act(kit, deal.id, kit.buyerId, 'submit_judge_report', {milestoneId: deal.mId, evidence: [labReport(kit, deal.id, deal.mId, 'FAIL', 'sellerLab')]}), 'not_the_named_judge');
    kit.clock.set(milestone(kit, deal.id).dispute.tierDeadline!);
    await runUntil(kit, deal.id, 'tier_3_mediation');
    const forged = mediatorRuling(kit, deal.id, deal.mId, {winner: 'buyer', reason: 'x'});
    expectCode(() => kit.service.lifecycle.submitMediatorRuling(deal.id, deal.mId, {winner: 'seller', reason: 'x'}, forged), 'bad_signature');
    const ruling = {winner: 'seller' as const, reason: 'The certificate comes from an agreed source; the buyer lab is not the named judge.'};
    kit.service.lifecycle.submitMediatorRuling(deal.id, deal.mId, ruling, mediatorRuling(kit, deal.id, deal.mId, ruling));
    await settleRuling(kit, deal.id);
    const published = outcome(kit, deal.id);
    expect([published.record.disputeTierReached, published.record.disputeWinner, published.record.disputeFeeAtomic, published.record.disputeFeePaidBy])
      .toEqual([3, 'seller', '5000000', 'buyer']);
    kit.close();
  });

  test('Tier 3 silence: the template default applies at the deadline', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, {type: 'full_refund_no_return'}, 'note');
    kit.clock.set(milestone(kit, deal.id).dispute.tierDeadline!);
    await runUntil(kit, deal.id, 'tier_2_evidence_rule');
    kit.clock.set(milestone(kit, deal.id).dispute.tierDeadline!);
    await runUntil(kit, deal.id, 'tier_3_mediation');
    kit.clock.set(milestone(kit, deal.id).dispute.tierDeadline!);
    await settleRuling(kit, deal.id);
    expect(outcome(kit, deal.id).record.decidedBy).toBe('mediator_timeout_default');
    expect(outcome(kit, deal.id).record.refundedToBuyerAtomic).toBe('10000000');
    kit.close();
  });

  test('conflicting reports from the named judge go to Tier 3', async () => {
    const kit = createKit();
    const deal = await fundedPhysical(kit);
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
    await runUntil(kit, deal.id, 'in_inspection');
    act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [labReport(kit, deal.id, deal.mId, 'FAIL'), labReport(kit, deal.id, deal.mId, 'PASS')]});
    await runUntil(kit, deal.id, 'tier_1_negotiation');
    act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'tier_3_mediation');
    expect(kit.service.lifecycle.audit(deal.id).some((row) => row.event === 'judge_reports_conflict')).toBe(true);
    kit.close();
  });

  test('a party that complies after the deadline is still recorded as late', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, {type: 'full_refund_no_return'}, 'judge_fail');
    act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'resolved');
    expectCode(() => act(kit, deal.id, kit.buyerId, 'comply_with_ruling', {milestoneId: deal.mId}), 'nothing_to_comply');
    kit.clock.set(milestone(kit, deal.id).dispute.obligations[0]!.dueAt);
    act(kit, deal.id, kit.sellerId, 'comply_with_ruling', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'settled');
    const compliance = outcome(kit, deal.id).record.rulingCompliance as {seller: {ignored: boolean; compliedAt: string}};
    expect(compliance.seller.ignored).toBe(true);
    expect(compliance.seller.compliedAt).not.toBeNull();
    expect(outcome(kit, deal.id).record.rulingExecutedBy).toBe('parties');
    kit.close();
  });
});

describe('remedy: full_refund_with_return', () => {
  async function returnPending() {
    const kit = createKit();
    const deal = await disputedPhysical(kit, {type: 'full_refund_with_return'}, 'judge_fail');
    act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'return_pending');
    return {kit, ...deal};
  }

  test('the refund is released only after the seller confirms the return', async () => {
    const {kit, id, mId} = await returnPending();
    act(kit, id, kit.buyerId, 'record_return_shipment', {milestoneId: mId, evidence: [{type: 'return_tracking', content: 'DHL 1234567890'}]});
    await settleTicks(kit);
    expect(milestone(kit, id).tranches[0]?.chain.onChainState).toBe('Disputed');
    expectCode(() => act(kit, id, kit.buyerId, 'confirm_return_received', {milestoneId: mId}), 'forbidden');
    act(kit, id, kit.sellerId, 'confirm_return_received', {milestoneId: mId});
    await runUntil(kit, id, 'settled');
    expect(outcome(kit, id).record.refundedToBuyerAtomic).toBe('10000000');
    kit.close();
  });

  test('the buyer never ships: the seller is paid at the return deadline', async () => {
    const {kit, id} = await returnPending();
    kit.clock.set(milestone(kit, id).dispute.followUpDeadline!);
    await settleRuling(kit, id);
    expect(outcome(kit, id).record.releasedToSellerAtomic).toBe('10000000');
    kit.close();
  });

  test('shipped but the seller is silent: Tier 3 decides, and a buyer ruling refunds without a loop', async () => {
    const {kit, id, mId} = await returnPending();
    act(kit, id, kit.buyerId, 'record_return_shipment', {milestoneId: mId, evidence: [{type: 'return_tracking', content: 'DHL 1234567890 delivered'}]});
    kit.clock.set(milestone(kit, id).dispute.followUpDeadline!);
    await runUntil(kit, id, 'tier_3_mediation');
    const ruling = {winner: 'buyer' as const, reason: 'The carrier confirms delivery of the return.'};
    kit.service.lifecycle.submitMediatorRuling(id, mId, ruling, mediatorRuling(kit, id, mId, ruling));
    await settleRuling(kit, id);
    expect(outcome(kit, id).record.refundedToBuyerAtomic).toBe('10000000');
    kit.close();
  });
});

describe('refunds, expiry, cancellation, termination', () => {
  for (const action of ['concession', 'termination'] as const) {
    for (const state of ['funded', 'in_inspection'] as const) {
      test(`${action} from ${state} waits for the refund request and publishes the correct outcome`, async () => {
        const kit = createKit();
        try {
          const {id, mId} = state === 'funded' ? await fundedDigital(kit) : await inspectingDigital(kit);
          if (action === 'concession') act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: mId});
          else {
            expectCode(() => kit.service.lifecycle.mutualTerminate(id, mId, 'aa'.repeat(64), 'bb'.repeat(64)), 'bad_signature');
            terminate(kit, id, mId);
          }
          const authorizations = () => kit.service.lifecycle.operations(id).filter((operation) => operation.kind === 'authorize_refund');
          expect(authorizations()).toHaveLength(0);
          await kit.service.tick();
          expect(authorizations()).toHaveLength(0);
          await runUntil(kit, id, 'refunded');
          const ref = milestone(kit, id).tranches[0]!.escrowRef!;
          const kinds = (kit.service.escrow as PaperContractEscrow).transactionLog(ref).map((tx) => tx.kind);
          expect(kinds.filter((kind) => kind === 'SetRefundRequested')).toHaveLength(1);
          expect(kinds.filter((kind) => kind === 'AuthorizeRefund')).toHaveLength(1);
          expect(kinds.indexOf('SetRefundRequested')).toBeLessThan(kinds.indexOf('AuthorizeRefund'));
          const published = outcome(kit, id);
          const sellerFault = action === 'concession' && state === 'in_inspection';
          expect([published.record.outcome, published.record.closedReason, published.state, published.fault]).toEqual([
            action === 'termination' ? 'CANCELLED' : 'REFUNDED',
            action === 'termination' ? 'mutual_termination' : 'seller_conceded',
            sellerFault ? 'failed' : 'cancelled', sellerFault ? 'seller' : 'none',
          ]);
          expect(published.record.refundedToBuyerAtomic).toBe('25000000');
        } finally {
          kit.close();
        }
      });
    }
  }

  test('the seller misses the delivery deadline: refund by timeout, EXPIRED, seller fault', async () => {
    const kit = createKit();
    const {id, mId} = await fundedDigital(kit);
    const deadlines = milestone(kit, id).deadlines!;
    kit.clock.set(deadlines.submitResultTime);
    expectCode(() => act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]}), 'deadline_passed');
    kit.clock.set(deadlines.submitResultTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
    await runUntil(kit, id, 'expired');
    const published = outcome(kit, id);
    expect([published.record.outcome, published.record.onTime, published.state, published.fault]).toEqual(['EXPIRED', false, 'failed', 'seller']);
    kit.close();
  });

  test('never funded before payByTime: EXPIRED with nothing moved', async () => {
    const kit = createKit();
    const contract = digital(kit);
    acceptTerms(kit, contract.id);
    kit.clock.set(milestone(kit, contract.id).deadlines!.payByTime);
    await runUntil(kit, contract.id, 'expired');
    const published = outcome(kit, contract.id);
    expect([published.record.outcome, published.record.fundedAt, published.record.releasedToSellerAtomic]).toEqual(['EXPIRED', null, '0']);
    expect(kit.service.lifecycle.operations(contract.id).some((item) => item.kind === 'lock_funds' && item.status === 'failed')).toBe(true);
    // The rail refused the late lock: nobody's fault.
    expect(published.fault).toBe('none');
    kit.close();
  });

  test('cancel before funding works; after a lock was sent it is refused', async () => {
    const kit = createKit();
    const first = digital(kit);
    act(kit, first.id, kit.buyerId, 'submit_for_acceptance');
    act(kit, first.id, kit.sellerId, 'cancel', {reason: 'changed my mind'});
    kit.service.publish();
    expect(outcome(kit, first.id).record.outcome).toBe('CANCELLED');
    const second = digital(kit);
    acceptTerms(kit, second.id);
    await settleTicks(kit, 1);
    expectCode(() => act(kit, second.id, kit.buyerId, 'cancel'), 'funding_in_flight');
    await runUntil(kit, second.id, 'funded');
    expect(() => act(kit, second.id, kit.buyerId, 'cancel')).toThrow(IllegalTransitionError);
    kit.close();
  });

  test('a dispute that cannot confirm before unlockTime does not hold funds', async () => {
    const kit = createKit();
    const {id, mId} = await fundedDigital(kit);
    const deadlines = milestone(kit, id).deadlines!;
    kit.clock.set(deadlines.submitResultTime - 60_000);
    act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]});
    await runUntil(kit, id, 'in_inspection');
    const current = milestone(kit, id);
    expect(current.inspectionCutoffAt).toBe(deadlines.unlockTime - kit.service.config.settings.disputeSubmitSafetyMarginMs);
    kit.clock.set(current.inspectionCutoffAt! - 1);
    act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [{type: 'note', content: 'last second'}]});
    kit.clock.set(deadlines.unlockTime);
    await kit.service.tick();
    expect(milestone(kit, id).state).toBe('auto_released');
    expect(kit.service.lifecycle.audit(id).some((row) => row.event === 'dispute_not_confirmed_before_unlock')).toBe(true);
    kit.close();
  });

  test('a Masumi admin settlement is accepted from chain facts', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, undefined, 'note');
    const current = milestone(kit, deal.id);
    kit.clock.set(current.deadlines!.externalDisputeUnlockTime);
    const escrow = kit.service.escrow as PaperContractEscrow;
    for (const tranche of current.tranches) escrow.simulateAdminSettlement(tranche.escrowRef!, '0', tranche.amountAtomic);
    await kit.service.tick();
    expect(milestone(kit, deal.id).state).toBe('settled');
    expect([outcome(kit, deal.id).record.rulingExecutedBy, outcome(kit, deal.id).record.disputeWinner]).toEqual(['masumi_admins', 'seller']);
    kit.close();
  });
});

describe('reliability scores', () => {
  test('outcomes accumulate across contracts, like the v1 lifecycle (pull request #15)', async () => {
    const kit = createKit();
    for (let deal = 0; deal < 2; deal++) {
      const {id, mId} = await inspectingDigital(kit);
      act(kit, id, kit.buyerId, 'accept', {milestoneId: mId});
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
      await runUntil(kit, id, 'settled');
    }
    const seller = kit.store.getReliabilityState(kit.sellerId, 'delivery', 'seller');
    expect(seller?.eventCount).toBe(2);
    expect(kit.service.publish()).toBe(0);
    expect(kit.store.getReliabilityState(kit.sellerId, 'delivery', 'seller')?.eventCount).toBe(2);
    kit.close();
  });

  test('an ignored ruling lowers the dispute score of the party that ignored it', async () => {
    const kit = createKit();
    const deal = await disputedPhysical(kit, {type: 'full_refund_no_return'}, 'judge_fail');
    act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId});
    await runUntil(kit, deal.id, 'resolved');
    kit.clock.set(milestone(kit, deal.id).dispute.obligations[0]!.dueAt);
    await runUntil(kit, deal.id, 'settled');
    const penalty = kit.store.getReliabilityState(kit.sellerId, 'dispute', 'seller');
    expect(penalty?.eventCount).toBe(1);
    expect(penalty!.beta).toBeGreaterThan(penalty!.alpha);
    kit.close();
  });
});

describe('milestones', () => {
  async function twoMilestones(kit: Kit) {
    const contract = kit.service.lifecycle.createContract({
      templateId: 'digital-machine-checkable',
      buyerId: kit.buyerId,
      sellerId: kit.sellerId,
      milestones: [
        {title: 'part 1', amountAtomic: '1000000', deliverable: {expectedSha256: sha('p1')}},
        {title: 'part 2', amountAtomic: '2000000', deliverable: {expectedSha256: sha('p2')}},
      ],
    }, kit.buyerId);
    acceptTerms(kit, contract.id);
    await runUntil(kit, contract.id, 'funded');
    expect(milestone(kit, contract.id, 1).deadlines).toBeNull();
    return contract;
  }

  test('each milestone is its own escrow and its own rated transaction; the next funds after a good outcome', async () => {
    const kit = createKit();
    const contract = await twoMilestones(kit);
    const first = milestone(kit, contract.id, 0).id;
    act(kit, contract.id, kit.sellerId, 'deliver', {milestoneId: first, evidence: [{type: 'content_file', content: 'p1'}]});
    await runUntil(kit, contract.id, 'in_inspection');
    act(kit, contract.id, kit.buyerId, 'accept', {milestoneId: first});
    kit.clock.set(milestone(kit, contract.id).deadlines!.unlockTime + kit.service.config.paperEscrow.autoWithdrawDelayMs);
    await runUntil(kit, contract.id, 'settled');
    await runUntil(kit, contract.id, 'funded', {index: 1});
    expect(milestone(kit, contract.id, 1).tranches[0]?.escrowRef).not.toBe(milestone(kit, contract.id, 0).tranches[0]?.escrowRef);
    act(kit, contract.id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, contract.id, 1).id});
    await runUntil(kit, contract.id, 'refunded', {index: 1});
    expect(kit.store.listContractIds({openOnly: true})).toEqual([]);
    expect(outcome(kit, contract.id, 0).transactionId).toBe(`${contract.id}/m0`);
    expect(outcome(kit, contract.id, 1).transactionId).toBe(`${contract.id}/m1`);
    expect(kit.store.getTransaction(`${contract.id}/m0`)?.value).toBe(1);
    kit.close();
  });

  test('a failed milestone cancels the unfunded rest', async () => {
    const kit = createKit();
    const contract = await twoMilestones(kit);
    act(kit, contract.id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, contract.id, 0).id});
    await runUntil(kit, contract.id, 'refunded');
    expect([milestone(kit, contract.id, 1).state, milestone(kit, contract.id, 1).closedReason]).toEqual(['cancelled', 'prior_milestone_failed']);
    kit.close();
  });
});

describe('guards', () => {
  test('unsigned, wrongly signed, wrong-party, wrong-state, and malformed actions are rejected', async () => {
    const kit = createKit();
    const deal = await fundedPhysical(kit);
    const request = {actionId: randomUUID(), contractId: deal.id, milestoneId: deal.mId, partyId: kit.sellerId, action: 'deliver' as const, evidence: physicalDelivery(kit, deal.id, deal.mId)};
    expectCode(() => kit.service.lifecycle.perform(request, sign(kit.keys.buyer.privateKey, partyActionBytes(request))), 'bad_signature');
    expectCode(() => act(kit, deal.id, kit.buyerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)}), 'forbidden');
    expect(() => act(kit, deal.id, kit.buyerId, 'accept', {milestoneId: deal.mId})).toThrow(IllegalTransitionError);
    expectCode(() => act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId).slice(1)}), 'evidence_count');
    const unsigned = physicalDelivery(kit, deal.id, deal.mId);
    delete unsigned[0]!.signer;
    expectCode(() => act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: unsigned}), 'signature_required');
    const tampered = physicalDelivery(kit, deal.id, deal.mId);
    tampered[0] = {...tampered[0]!, content: String(tampered[0]!.content).replace('PASS', 'PASS ')};
    expectCode(() => act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: tampered}), 'bad_signature');
    expectCode(() => act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: [...physicalDelivery(kit, deal.id, deal.mId), {type: 'meme', content: 'x'}]}), 'evidence_type_not_allowed');
    act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)});
    expectCode(() => act(kit, deal.id, kit.sellerId, 'deliver', {milestoneId: deal.mId, evidence: physicalDelivery(kit, deal.id, deal.mId)}), 'operation_in_flight');
    await runUntil(kit, deal.id, 'in_inspection');
    expectCode(() => act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: []}), 'evidence_required');
    expectCode(() => act(kit, deal.id, kit.buyerId, 'escalate', {milestoneId: deal.mId}), 'escalation_not_allowed');
    kit.clock.set(milestone(kit, deal.id).inspectionCutoffAt!);
    expectCode(() => act(kit, deal.id, kit.buyerId, 'dispute', {milestoneId: deal.mId, evidence: [{type: 'note', content: 'late'}]}), 'inspection_closed');
    kit.close();
  });

  test('a replayed action id returns the same contract; reusing it for another action is refused', async () => {
    const kit = createKit();
    const {id, mId} = await inspectingDigital(kit);
    const actionId = randomUUID();
    const first = act(kit, id, kit.buyerId, 'accept', {milestoneId: mId, actionId});
    const replay = act(kit, id, kit.buyerId, 'accept', {milestoneId: mId, actionId});
    expect(replay.version).toBe(first.version);
    expectCode(() => act(kit, id, kit.buyerId, 'dispute', {milestoneId: mId, actionId, evidence: [{type: 'note', content: 'x'}]}), 'action_id_reused');
    kit.close();
  });

  test('creation checks template, remedy, deliverable, judge, mediator, tranche cap, and terms signatures', () => {
    const kit = createKit();
    const base = {
      templateId: 'physical-objective-spec', buyerId: kit.buyerId, sellerId: kit.sellerId,
      milestones: [{title: 'x', amountAtomic: '100', deliverable: {specDocumentSha256: sha('s'), description: 'd', quantity: 1, unit: 'kg'}}],
    };
    const lifecycle = kit.service.lifecycle;
    const whitelist = [{id: 'i1', publicKeyHex: kit.keys.judge.publicKeyHex}];
    expectCode(() => lifecycle.createContract({...base, templateId: 'digital-subjective'}, kit.buyerId), 'template_not_enabled');
    expectCode(() => lifecycle.createContract(base, kit.buyerId), 'inspectors_required');
    expectCode(() => lifecycle.createContract({...base, inspectorWhitelist: whitelist}, kit.buyerId), 'judge_required');
    expectCode(() => lifecycle.createContract({...base, inspectorWhitelist: whitelist, judgeInspectorId: 'i1', remedy: {type: 'partial_release', sellerShareBps: 0}}, kit.buyerId), 'invalid_remedy');
    expectCode(() => lifecycle.createContract({...base, inspectorWhitelist: whitelist, judgeInspectorId: 'i1', milestones: [{...base.milestones[0]!, deliverable: {description: 'd'}}]}, kit.buyerId), 'invalid_deliverable');
    expectCode(() => lifecycle.createContract({...base, inspectorWhitelist: whitelist, judgeInspectorId: 'i1', milestones: [{...base.milestones[0]!, amountAtomic: '1.5'}]}, kit.buyerId), 'invalid_amount');
    expectCode(() => lifecycle.createContract({...base, inspectorWhitelist: whitelist, judgeInspectorId: 'i1'}, 'stranger'), 'forbidden');
    const contract = lifecycle.createContract({...base, inspectorWhitelist: whitelist, judgeInspectorId: 'i1', remedy: {type: 'full_refund_no_return'}}, kit.buyerId);
    expectCode(() => lifecycle.termsBytes(contract.id), 'terms_not_frozen');
    act(kit, contract.id, kit.buyerId, 'submit_for_acceptance');
    expectCode(() => lifecycle.signTerms(contract.id, kit.buyerId, sign(kit.keys.seller.privateKey, lifecycle.termsBytes(contract.id))), 'bad_signature');
    expect(lifecycle.termsBytes(contract.id)).toContain('"custodyModel":"platform_custodial_test_only"');
    kit.close();

    const capped = createKit({env: envOf([['CONTRACT_MAX_TRANCHES_PER_MILESTONE', '1']])});
    expectCode(() => digital(capped, {type: 'partial_release', sellerShareBps: 5000}), 'too_many_tranches');
    capped.close();

    const noMediator = createKit({env: envOf([['CONTRACT_MEDIATOR_PUBLIC_KEY_HEX', '']])});
    expectCode(() => digital(noMediator), 'mediator_required');
    noMediator.close();
  });

  test('evidence above the size limit is refused before it reaches the store', async () => {
    const kit = createKit({env: envOf([['CONTRACT_MAX_EVIDENCE_BYTES', '16']])});
    const {id, mId} = await fundedDigital(kit);
    expectCode(() => act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]}), 'evidence_too_large');
    kit.close();
  });
});

describe('audit log and hashes', () => {
  test('every transition is audited, labelled paper, hash-chained, and append-only', async () => {
    const kit = createKit();
    const {id} = await inspectingDigital(kit);
    const audit = kit.service.lifecycle.audit(id);
    for (const entry of milestone(kit, id).history.filter((item) => item.from !== null)) {
      expect(audit.some((row) => row.event === entry.event && row.fromState === entry.from && row.toState === entry.to)).toBe(true);
    }
    expect(audit.every((row) => row.mode === 'paper')).toBe(true);
    expect(kit.store.verifyContractAuditChain()).toBeNull();
    kit.close();
  });

  test('the delivered result hash follows MIP-004 over the stored manifest bytes', async () => {
    const kit = createKit();
    const {id} = await inspectingDigital(kit);
    const current = milestone(kit, id);
    const tranche = current.tranches[0]!;
    expect(tranche.resultHash).toBe(sha(`${tranche.identifierFromPurchaser};${current.resultManifest}`));
    expect(tranche.chain.resultHash).toBe(tranche.resultHash);
    kit.close();
  });
});
