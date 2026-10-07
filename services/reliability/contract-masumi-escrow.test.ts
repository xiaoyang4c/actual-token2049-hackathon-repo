/**
 * @fileoverview The Masumi V2 escrow adapter against a fake payment
 * service that applies the MPS rules. The fixture transport is simulated,
 * so every contract here stays labelled paper.
 */

import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';
import {loadPaymentConfig} from '../cardano-agents-ts/config';
import {
  acceptTerms, act, complyAll, createKit, envOf, INSPECTORS, inspectorWhitelist, labReport, milestone,
  physicalDelivery, runUntil, type Kit,
} from './contract-kit';
import {FakeMps} from './contract-fake-mps';
import {MasumiContractEscrow} from './contract-masumi-escrow';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FILE = 'id,price\n1,100\n';
const USDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const AGENT = `agent-${'a'.repeat(60)}`;
const MASUMI_ENV = envOf([
  ['MASUMI_PAYMENT_SOURCE_TYPE', 'Web3CardanoV2'],
  ['MASUMI_AGENT_IDENTIFIER', AGENT],
  ['MASUMI_SUPPORTED_SOURCE_INDEX', '0'],
]);
const credentials = (reference: string) => `fixture-${reference}`;

function masumiKit(): {kit: Kit; mps: FakeMps} {
  const base = createKit();
  base.close();
  const clock = base.clock;
  const mps = new FakeMps(clock);
  const kit = createKit({clock, keys: base.keys, env: MASUMI_ENV, masumiTransport: mps.transport, resolveCredential: credentials});
  return {kit, mps};
}

function digital(kit: Kit): string {
  return kit.service.lifecycle.createContract({
    templateId: 'digital-machine-checkable',
    buyerId: kit.buyerId,
    sellerId: kit.sellerId,
    milestones: [{title: 'file', amountAtomic: '25000000', deliverable: {expectedSha256: sha(FILE)}}],
  }, kit.buyerId).id;
}

describe('Masumi V2 escrow adapter (fake payment service)', () => {
  test('a fixture transport keeps contracts labelled paper', () => {
    const {kit} = masumiKit();
    expect(kit.service.mode).toBe('paper');
    expect(kit.service.escrow).toBeInstanceOf(MasumiContractEscrow);
    kit.close();
  });

  test('refuses a V1 payment source and an unregistered agent', () => {
    const v1 = loadPaymentConfig(envOf([['MASUMI_PAYMENT_SOURCE_TYPE', 'Web3CardanoV1'], ['MASUMI_AGENT_IDENTIFIER', AGENT]]));
    expect(() => new MasumiContractEscrow(v1, {agentIdentifier: AGENT, supportedPaymentSourceIndex: 0, sellerPayout: 'custodial_wallet'})).toThrow(/Web3CardanoV2/);
    const v2 = loadPaymentConfig(MASUMI_ENV);
    expect(() => new MasumiContractEscrow(v2, {agentIdentifier: 'short', supportedPaymentSourceIndex: 0, sellerPayout: 'custodial_wallet'})).toThrow(/57/);
  });

  test('runs a digital deal through the MPS endpoints with USDM, a hex nonce, and legal deadlines', async () => {
    const {kit, mps} = masumiKit();
    const id = digital(kit);
    acceptTerms(kit, id);
    await runUntil(kit, id, 'funded');

    const payment = mps.calls.find((call) => call.path === '/payment')!.body;
    expect(payment.RequestedFunds).toEqual([{amount: '25000000', unit: USDM}]);
    expect(String(payment.identifierFromPurchaser)).toMatch(/^[0-9a-f]{14,26}$/);
    expect(payment.paymentSourceType).toBe('Web3CardanoV2');
    expect(payment).not.toHaveProperty('forceLayer');
    expect(payment).not.toHaveProperty('sellerReturnAddress');
    const purchase = mps.calls.find((call) => call.path === '/purchase')!.body;
    expect(purchase.Amounts).toEqual([{amount: '25000000', unit: USDM}]);
    expect(purchase.unlockTime).toMatch(/^[0-9]+$/);
    expect(purchase).not.toHaveProperty('paymentForceLayer');

    const mId = milestone(kit, id).id;
    act(kit, id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: [{type: 'content_file', content: FILE}]});
    await runUntil(kit, id, 'in_inspection');
    const tranche = milestone(kit, id).tranches[0]!;
    expect(mps.calls.find((call) => call.path === '/payment/submit-result')!.body.submitResultHash).toBe(tranche.resultHash);

    kit.clock.set(milestone(kit, id).inspectionCutoffAt!);
    await runUntil(kit, id, 'auto_released');
    kit.clock.set(milestone(kit, id).deadlines!.unlockTime + 30_000);
    await runUntil(kit, id, 'settled');
    const outcome = kit.store.getOutcome(`${id}/m0`)!;
    expect(outcome.state).toBe('successful');
    expect((outcome.evidence as {releasedToSellerAtomic: string}).releasedToSellerAtomic).toBe('25000000');
    kit.close();
  });

  test('a ruling uses the V2 authorize endpoints: buyer AuthorizeWithdrawal, seller AuthorizeRefund', async () => {
    const {kit, mps} = masumiKit();
    const contract = kit.service.lifecycle.createContract({
      templateId: 'physical-objective-spec',
      buyerId: kit.buyerId,
      sellerId: kit.sellerId,
      milestones: [{title: 'coffee', amountAtomic: '10000000', deliverable: {specDocumentSha256: sha('spec'), description: 'arabica', quantity: 1, unit: 'kg'}}],
      inspectorWhitelist: inspectorWhitelist(kit),
      judgeInspectorId: INSPECTORS.judge,
    }, kit.sellerId);
    acceptTerms(kit, contract.id);
    await runUntil(kit, contract.id, 'funded');
    const mId = milestone(kit, contract.id).id;
    act(kit, contract.id, kit.sellerId, 'deliver', {milestoneId: mId, evidence: physicalDelivery(kit, contract.id, mId)});
    await runUntil(kit, contract.id, 'in_inspection');
    act(kit, contract.id, kit.buyerId, 'dispute', {milestoneId: mId, evidence: [labReport(kit, contract.id, mId, 'FAIL')]});
    await runUntil(kit, contract.id, 'tier_1_negotiation');
    expect(mps.count('/purchase/request-refund')).toBe(2);
    act(kit, contract.id, kit.sellerId, 'escalate', {milestoneId: mId});
    await runUntil(kit, contract.id, 'resolved');
    complyAll(kit, contract.id);
    await runUntil(kit, contract.id, 'settled');
    expect(mps.count('/purchase/cancel-refund-request')).toBe(1);
    expect(mps.count('/payment/authorize-refund')).toBe(1);
    const evidence = kit.store.getOutcome(`${contract.id}/m0`)!.evidence as {releasedToSellerAtomic: string; refundedToBuyerAtomic: string};
    expect([evidence.releasedToSellerAtomic, evidence.refundedToBuyerAtomic]).toEqual(['7000000', '3000000']);
    kit.close();
  });

  test('a lost purchase response: the retry finds the purchase on MPS and does not buy twice', async () => {
    const {kit, mps} = masumiKit();
    const id = digital(kit);
    acceptTerms(kit, id);
    mps.loseNextResponse('/purchase');
    await runUntil(kit, id, 'funded');
    expect(mps.count('/purchase')).toBe(1);
    const lock = kit.service.lifecycle.operations(id).find((item) => item.kind === 'lock_funds')!;
    expect([lock.status, lock.attempts]).toEqual(['done', 2]);
    kit.close();
  });

  test('a rejected purchase (payByTime passed) fails the operation and the milestone expires', async () => {
    const {kit} = masumiKit();
    const id = digital(kit);
    acceptTerms(kit, id);
    await kit.service.lifecycle.processOperations(); // terms created, purchase not yet sent
    kit.clock.set(milestone(kit, id).deadlines!.payByTime);
    await runUntil(kit, id, 'expired');
    expect(kit.service.lifecycle.operations(id).find((item) => item.kind === 'lock_funds')!.status).toBe('failed');
    kit.close();
  });

  test('a concession waits for the buyer refund request before seller authorization', async () => {
    const {kit, mps} = masumiKit();
    try {
      const id = digital(kit);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}]});
      await runUntil(kit, id, 'in_inspection');
      act(kit, id, kit.sellerId, 'concede_refund', {milestoneId: milestone(kit, id).id});
      await kit.service.tick();
      expect(mps.count('/purchase/request-refund')).toBe(1);
      expect(mps.count('/payment/authorize-refund')).toBe(0);
      await runUntil(kit, id, 'refunded');
      expect(mps.count('/payment/authorize-refund')).toBe(1);
      expect(kit.service.lifecycle.operations(id).every((operation) => operation.status === 'done')).toBe(true);
      expect(milestone(kit, id).tranches[0]!.chain.paidToBuyerAtomic).toBe('25000000');
    } finally {
      kit.close();
    }
  });

  test('confirmed MPS history recovers delivery after automatic payment', async () => {
    const {kit, mps} = masumiKit();
    try {
      const id = digital(kit);
      acceptTerms(kit, id);
      await runUntil(kit, id, 'funded');
      const submittedAt = kit.clock.now();
      act(kit, id, kit.sellerId, 'deliver', {milestoneId: milestone(kit, id).id, evidence: [{type: 'content_file', content: FILE}]});
      await kit.service.lifecycle.processOperations();
      kit.clock.set(milestone(kit, id).deadlines!.unlockTime + 30_000);
      await runUntil(kit, id, 'settled');
      expect(milestone(kit, id).deliveredAt).toBe(submittedAt + 3_000);
      expect(milestone(kit, id).tranches[0]!.chain.history?.some((entry) => entry.to === 'ResultSubmitted')).toBe(true);
      expect(kit.store.getOutcome(`${id}/m0`)?.state).toBe('successful');
      expect(mps.count('/payment/submit-result')).toBe(1);
    } finally {
      kit.close();
    }
  });
});
