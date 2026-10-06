import {afterEach, describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore, type PaymentReceiptRecord} from '../../packages/db/src';
import type {CardanoAdapter} from './cardano';
import {loadPaymentConfig} from './config';
import type {MasumiAdapter, MasumiSettlementSnapshot, MasumiSettlementView, MasumiTerms} from './masumi';
import {PaymentReconciler} from './reconciliation';
import {createPaymentRequest, type PaymentSession} from './runtime-protocol';
import {paymentConfigurationHash} from './runtime-setup';
import type {SettlementVerificationRequest} from './settlement-evidence';
import {PaymentError, sha256} from './types';

const DEPOSIT = 'ab'.repeat(32);
const START = Date.parse('2026-10-04T12:00:00.000Z');
const fixtures: {close: () => Promise<void>}[] = [];

/** API observations and independent chain confirmations can move separately. */
function fixture(version: MasumiTerms['paymentSourceType'] = 'Web3CardanoV1', databasePath = ':memory:') {
  const config = loadPaymentConfig(Object.fromEntries([
    ['CARDANO_RECEIPT_DB', databasePath], ['MASUMI_PAYMENT_SOURCE_TYPE', version],
  ]));
  const request = createPaymentRequest('fixture', {
    scheme: 'exact', network: config.network, maxAmountRequired: '1000000', asset: 'lovelace',
    payTo: config.scorePayTo, resource: '/score', description: 'Fixture', maxTimeoutSeconds: 60,
    inputHash: 'cd'.repeat(32),
  }, config, new Date(START).toISOString());
  const terms: MasumiTerms = {
    ...request, blockchainIdentifier: 'fixture-payment', sellerVkey: 'fixture-seller',
    escrowAddress: 'addr_test1_fixture_escrow', amountLovelace: 1_000_000,
    payByTime: String(Date.parse(request.payByTime)), submitResultTime: String(Date.parse(request.submitResultTime)),
    unlockTime: String(Date.parse(request.unlockTime)), externalDisputeUnlockTime: String(Date.parse(request.externalDisputeUnlockTime)),
  };
  const saved: PaymentSession = {
    mode: config.mode, configurationHash: paymentConfigurationHash(config), fingerprint: 'fixture',
    bindInput: true, request, terms, purchaseAttempted: true, purchaseRequested: true,
  };
  const receipt: PaymentReceiptRecord = {
    receiptId: 'fixture-receipt', idempotencyKey: 'fixture', payer: config.walletAddress,
    txHash: DEPOSIT, network: config.network, amount: 1_000_000, asset: 'lovelace', payTo: config.scorePayTo,
    resource: '/score', status: 'submitted', simulated: true, createdAt: new Date(START).toISOString(),
    inputHash: request.inputHash, protocolData: JSON.stringify(saved),
  };
  const state = {
    now: START, snapshot: {payment: null, purchase: null} as MasumiSettlementSnapshot,
    apiError: undefined as Error | undefined, chainError: undefined as Error | undefined,
    readGate: undefined as (() => Promise<void>) | undefined,
    readCalls: 0, mutationCalls: 0,
    proofs: new Map<string, {confirmed: boolean; confirmations: number; reason?: string; resultHash?: string | null}>(),
    checks: [] as SettlementVerificationRequest[],
    store: AgentStore.open(databasePath), closed: false, worker: undefined as PaymentReconciler | undefined,
  };
  if (!state.store.getPaymentReceipt(receipt.receiptId)) state.store.insertPaymentReceipt(receipt);
  state.proofs.set(DEPOSIT, {confirmed: true, confirmations: 3});
  const cardano: CardanoAdapter = {
    simulated: true,
    async getWalletBalance() { return 100_000_000; },
    async submitTransaction() { state.mutationCalls++; throw new Error('reconciliation must not submit'); },
    async verifyPayment() {
      if (state.chainError) throw state.chainError;
      return state.proofs.get(DEPOSIT) ?? {confirmed: false, confirmations: 0};
    },
    async observeSettlementTransaction() { throw new Error('fixture verifies independent chain facts directly'); },
    async verifySettlement(check) {
      if (state.chainError) throw state.chainError;
      state.checks.push(check);
      const proof = state.proofs.get(check.transaction.txHash ?? '') ?? {confirmed: false, confirmations: 0, reason: 'not indexed'};
      const view = [state.snapshot.payment, state.snapshot.purchase].find((candidate) => candidate?.transactions
        .some((tx) => tx.txHash === check.transaction.txHash && tx.newOnChainState === check.transaction.newOnChainState));
      return {txHash: check.transaction.txHash, onChainState: check.transaction.newOnChainState,
        resultHash: view?.resultHash ?? null, ...proof, evidence: []};
    },
  };
  const masumi: MasumiAdapter = {
    simulated: true,
    async createPayment() { state.mutationCalls++; return terms; },
    async createPurchase() { state.mutationCalls++; return {onChainState: 'FundsLocked'}; },
    async getPurchase() { throw new Error('reconciler must preserve the full settlement observation'); },
    async submitResult() { state.mutationCalls++; },
    async requestRefund() { state.mutationCalls++; },
    async getSettlement() {
      state.readCalls++;
      if (state.readGate) await state.readGate();
      if (state.apiError) throw state.apiError;
      return structuredClone(state.snapshot);
    },
  };
  const makeWorker = () => new PaymentReconciler({
    store: state.store, config, cardano, masumi, runExclusive: async (receiptId, run) => { void receiptId; await run(); },
    now: () => state.now, random: () => 0.5, baseBackoffMs: 1_000, maxBackoffMs: 8_000,
    intervalMs: 60_000, terminalCheckMs: 30_000,
  });
  const instance = {
    state, config, saved, receipt, terms, cardano, masumi, makeWorker,
    save() {
      receipt.protocolData = JSON.stringify(saved);
      state.store.updatePaymentReceipt(receipt);
    },
    deliver() {
      receipt.responseJson = '{"scores":[0.42]}';
      receipt.resultHash = sha256(receipt.responseJson);
      receipt.status = 'delivered';
      saved.resultQueued = true;
      this.save();
    },
    setState(onChainState: string, overrides: Partial<MasumiSettlementView> = {}) {
      const txHash = onChainState === 'FundsLocked' ? DEPOSIT : sha256(onChainState);
      const view: MasumiSettlementView = {
        onChainState, resultHash: ['FundsLocked', 'RefundAuthorized', 'RefundWithdrawn'].includes(onChainState)
          ? undefined : receipt.resultHash, transactions: [
          {txHash, status: 'Confirmed', newOnChainState: onChainState},
          ...(txHash === DEPOSIT ? [] : [{txHash: DEPOSIT, status: 'Confirmed', newOnChainState: 'FundsLocked'}]),
        ],
        withdrawnForSeller: onChainState === 'RefundWithdrawn' ? 0 : 950_000,
        withdrawnForBuyer: onChainState === 'RefundWithdrawn' ? 950_000 : 0,
        ...overrides,
      };
      state.snapshot = {payment: view, purchase: structuredClone(view)};
      if (!state.proofs.has(txHash)) state.proofs.set(txHash, {confirmed: true, confirmations: 3});
      return txHash;
    },
    summary() { return state.store.getPaymentSettlement(receipt.receiptId)!; },
    observations() { return state.store.listPaymentSettlementObservations(receipt.receiptId); },
    async next() {
      state.now = Date.parse(this.summary().nextCheckAt!);
      return state.worker!.tick();
    },
    async close() {
      if (state.closed) return;
      await state.worker?.stop();
      state.store.close();
      state.closed = true;
    },
  };
  instance.setState('FundsLocked');
  state.worker = makeWorker();
  fixtures.push(instance);
  return instance;
}

afterEach(async () => {
  for (const instance of fixtures.splice(0)) await instance.close();
});

describe('observation-only Masumi settlement reconciliation', () => {
  test('delayed result and payout confirmations stay separate from delivered scores', async () => {
    const f = fixture();
    f.deliver();
    f.setState('FundsLocked', {nextAction: {requestedAction: 'SubmitResultRequested', resultHash: f.receipt.resultHash}});
    const delivered = f.state.store.getPaymentReceipt(f.receipt.receiptId);
    expect(await f.state.worker!.tick()).toBe(1);
    expect(f.summary().status).toBe('result_queued');
    expect(f.observations().at(-1)?.verified).toBe(false);
    expect(await f.state.worker!.tick()).toBe(0);
    const result = f.setState('ResultSubmitted');
    f.state.proofs.set(result, {confirmed: false, confirmations: 1});
    await f.next();
    expect(f.summary().status).toBe('result_queued');
    f.state.proofs.set(result, {confirmed: true, confirmations: 3});
    await f.next();
    expect(f.summary().status).toBe('result_confirmed');
    f.state.now = Number(f.terms.unlockTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('withdrawal_available');
    const withdrawal = f.setState('Withdrawn');
    f.state.proofs.set(withdrawal, {confirmed: false, confirmations: 2});
    await f.next();
    expect(f.summary().status).toBe('withdrawal_pending');
    expect(f.summary().lastVerifiedStatus).toBe('withdrawal_available');
    f.state.proofs.set(withdrawal, {confirmed: true, confirmations: 3});
    await f.next();
    expect(f.summary().status).toBe('withdrawn');
    expect(Date.parse(f.summary().nextCheckAt!) - f.state.now).toBe(30_000);
    expect(f.state.checks.at(-1)).toMatchObject({kind: 'withdrawal', depositTxHash: DEPOSIT,
      sellerAddress: f.receipt.payTo, buyerAddress: f.receipt.payer, resultHash: f.receipt.resultHash});
    expect(f.state.store.getPaymentReceipt(f.receipt.receiptId)).toEqual(delivered);
    expect(f.state.mutationCalls).toBe(0);
  });

  test('confirmed settlement survives stale API regression and reopens on an actual rollback', async () => {
    const f = fixture();
    f.deliver();
    const withdrawal = f.setState('Withdrawn');
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('withdrawn');
    f.setState('FundsLocked');
    await f.next();
    await f.next();
    expect(f.summary().status).toBe('withdrawn');
    f.state.proofs.set(withdrawal, {confirmed: false, confirmations: 0, reason: 'transaction rolled back'});
    await f.next();
    expect(f.summary().status).toBe('result_queued');
    expect(f.summary().lastVerifiedStatus).toBe('withdrawn');
    expect(JSON.parse(f.observations().at(-1)!.evidenceJson).notes).toContain(
      'Previously confirmed settlement lost confirmation; its reconciliation is reopened');
    expect(f.summary().nextCheckAt).not.toBeNull();
  });

  test('missing confirmations for a reported terminal transaction reopen its polling', async () => {
    const f = fixture();
    f.deliver();
    const withdrawal = f.setState('Withdrawn');
    await f.state.worker!.tick();
    f.state.proofs.set(withdrawal, {confirmed: false, confirmations: 1});
    await f.next();
    expect(f.summary().status).toBe('withdrawal_pending');
    expect(f.summary().lastVerifiedStatus).toBe('withdrawn');
    expect(Date.parse(f.summary().nextCheckAt!) - f.state.now).toBe(2_000);
  });

  test('terminal proof remains available after more API errors than the display history limit', async () => {
    const f = fixture();
    f.deliver();
    f.setState('Withdrawn');
    await f.state.worker!.tick();
    f.state.apiError = new PaymentError('fixture unavailable', 503);
    for (let count = 0; count < 105; count++) await f.next();
    expect(f.observations()).toHaveLength(100);
    f.state.apiError = undefined;
    f.setState('FundsLocked');
    await f.next();
    expect(f.summary().status).toBe('withdrawn');
    expect(f.summary().lastError).toBeUndefined();
  });

  test('a stale action error cannot hide independently confirmed terminal settlement', async () => {
    const f = fixture();
    f.deliver();
    f.setState('Withdrawn', {nextAction: {requestedAction: 'WithdrawInitiated', errorType: 'NetworkError'}});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('withdrawn');
    expect(f.summary().lastVerifiedStatus).toBe('withdrawn');
    expect(JSON.parse(f.observations().at(-1)!.evidenceJson).notes).toContain('Masumi action requires attention: NetworkError');
  });

  for (const version of ['Web3CardanoV1', 'Web3CardanoV2'] as const) {
    test(`${version} permits a timed refund without refund authorization`, async () => {
      const f = fixture(version);
      f.state.now = Number(f.terms.submitResultTime);
      await f.state.worker!.tick();
      expect(f.summary().status).toBe('funds_locked');
      f.state.now++;
      f.state.store.schedulePaymentSettlement(f.receipt.receiptId, new Date(f.state.now).toISOString());
      await f.state.worker!.tick();
      expect(f.summary().status).toBe('refund_available');
      const refund = f.setState('RefundWithdrawn', {resultHash: undefined});
      f.state.proofs.set(refund, {confirmed: false, confirmations: 0});
      await f.next();
      expect(f.summary().status).toBe('refund_pending');
      f.state.proofs.set(refund, {confirmed: true, confirmations: 3});
      await f.next();
      expect(f.summary().status).toBe('refunded');
      expect(f.state.store.getPaymentReceipt(f.receipt.receiptId)?.status).toBe('submitted');
      expect(f.state.mutationCalls).toBe(0);
    });
  }

  test('refund request with an existing result does not become a timed refund', async () => {
    const f = fixture();
    f.deliver();
    f.setState('RefundRequested');
    f.state.now = Number(f.terms.externalDisputeUnlockTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('refund_requested');
    expect(f.summary().lastVerifiedStatus).toBe('refund_requested');
  });

  test('timed refund eligibility requires a proven empty result hash even when Masumi omits it', async () => {
    const f = fixture();
    f.deliver();
    const requested = f.setState('RefundRequested', {resultHash: undefined});
    f.state.proofs.set(requested, {confirmed: true, confirmations: 3, resultHash: f.receipt.resultHash});
    f.state.now = Number(f.terms.submitResultTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('refund_requested');
    f.state.proofs.set(requested, {confirmed: true, confirmations: 3, resultHash: undefined});
    await f.next();
    expect(f.summary().status).toBe('refund_requested');
    f.state.proofs.set(requested, {confirmed: true, confirmations: 3, resultHash: null});
    await f.next();
    expect(f.summary().status).toBe('refund_available');
  });

  test('V1 refund authorization returns to RefundRequested after clearing the result', async () => {
    const f = fixture();
    f.deliver();
    f.setState('Disputed');
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('disputed');
    f.setState('RefundRequested', {resultHash: undefined});
    await f.next();
    expect(f.summary().status).toBe('refund_requested');
    f.state.now = Number(f.terms.submitResultTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('refund_available');
  });

  test('V2 authorizations bypass withdrawal deadlines and participant cooldowns', async () => {
    const f = fixture('Web3CardanoV2');
    f.deliver();
    const future = String(START + 86_400_000);
    f.setState('WithdrawAuthorized', {sellerCoolDownTime: future, buyerCoolDownTime: future});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('withdrawal_available');
    f.setState('RefundAuthorized', {resultHash: undefined, sellerCoolDownTime: future, buyerCoolDownTime: future});
    await f.next();
    expect(f.summary().status).toBe('refund_available');
    expect(f.state.checks.at(-1)).toMatchObject({kind: 'state', transaction: {newOnChainState: 'RefundAuthorized'}});
  });

  test('V1 rejects V2-only authorization states', async () => {
    const f = fixture();
    f.setState('RefundAuthorized', {resultHash: undefined});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('recovery_required');
    expect(f.summary().lastVerifiedStatus).toBeUndefined();
  });

  test('mixed views derive eligibility only from the state whose current datum was proven', async () => {
    const f = fixture('Web3CardanoV2');
    f.deliver();
    for (const stale of ['RefundAuthorized', 'Disputed', 'WithdrawAuthorized']) {
      f.setState('ResultSubmitted');
      const staleHash = sha256(stale);
      f.state.snapshot.purchase = {
        onChainState: stale, resultHash: stale === 'RefundAuthorized' ? undefined : f.receipt.resultHash,
        transactions: [{txHash: staleHash, status: 'Confirmed', newOnChainState: stale}],
      };
      f.state.proofs.set(staleHash, {confirmed: false, confirmations: 3, reason: 'historical escrow is spent'});
      if (!f.summary()) await f.state.worker!.tick();
      else await f.next();
      expect(f.summary().status).toBe('result_confirmed');
      expect(f.summary().lastVerifiedStatus).toBe('result_confirmed');
      expect(f.state.now).toBeLessThan(Number(f.terms.unlockTime));
    }
  });

  test('cooldowns wake queued actions at their eligible time without verifying them as settled', async () => {
    const f = fixture();
    f.deliver();
    f.setState('FundsLocked', {sellerCoolDownTime: String(START + 300),
      nextAction: {requestedAction: 'SubmitResultRequested', resultHash: f.receipt.resultHash}});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('result_queued');
    expect(Date.parse(f.summary().nextCheckAt!) - START).toBe(300);
    expect(f.summary().lastVerifiedStatus).toBeUndefined();
  });

  test('requires matching transaction evidence for a dispute and retains its settlement branch', async () => {
    const f = fixture();
    f.deliver();
    const dispute = f.setState('Disputed');
    f.state.proofs.set(dispute, {confirmed: false, confirmations: 0});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('disputed');
    expect(f.summary().lastVerifiedStatus).toBeUndefined();
    f.state.proofs.set(dispute, {confirmed: true, confirmations: 3});
    await f.next();
    expect(f.summary().lastVerifiedStatus).toBe('disputed');
    f.setState('DisputedWithdrawn', {withdrawnForSeller: 500_000, withdrawnForBuyer: 450_000});
    await f.next();
    expect(f.summary().status).toBe('disputed_settled');
    expect(f.state.checks.at(-1)?.kind).toBe('disputed_withdrawal');
  });

  test('expiry distinguishes explicitly unattempted purchases from ambiguous historical receipts', async () => {
    const f = fixture();
    f.saved.purchaseAttempted = false;
    f.saved.terms = undefined;
    f.receipt.txHash = '';
    f.save();
    f.state.now = Date.parse(f.saved.request.payByTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('expired_unfunded');
    expect(f.state.readCalls).toBe(0);
    f.saved.purchaseAttempted = undefined;
    f.saved.terms = f.terms;
    f.save();
    f.state.snapshot = {payment: null, purchase: null};
    await f.next();
    expect(f.observations().at(-1)?.status).toBe('recovery_required');
    expect(f.observations().at(-1)?.verified).toBe(false);
    expect(f.summary().status).toBe('recovery_required');
    expect(JSON.parse(f.observations().at(-1)!.evidenceJson).notes[0]).toContain('may have locked funds');
    expect(f.summary().nextCheckAt).not.toBeNull();
  });

  test('API errors preserve verified facts with bounded persistent backoff and restart recovery', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'masumi-reconciliation-'));
    const f = fixture('Web3CardanoV1', join(directory, 'receipts.sqlite'));
    try {
      await f.state.worker!.tick();
      expect(f.summary().lastVerifiedStatus).toBe('funds_locked');
      f.state.apiError = new PaymentError('fixture Masumi unavailable', 503);
      for (let index = 0; index < 5; index++) await f.next();
      expect(f.summary().status).toBe('funds_locked');
      expect(f.summary().lastError).toBe('fixture Masumi unavailable');
      expect(Date.parse(f.summary().nextCheckAt!) - f.state.now).toBe(8_000);
      const due = f.summary().nextCheckAt;
      const attempts = f.summary().attemptCount;
      await f.state.worker!.stop();
      f.state.store.close();
      f.state.store = AgentStore.open(join(directory, 'receipts.sqlite'));
      f.state.worker = f.makeWorker();
      expect(await f.state.worker.tick()).toBe(0);
      expect(f.summary().nextCheckAt).toBe(due);
      expect(f.summary().attemptCount).toBe(attempts);
      f.state.apiError = undefined;
      await f.next();
      expect(f.summary().lastError).toBeUndefined();
      expect(f.summary().attemptCount).toBe(attempts + 1);
    } finally {
      await f.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('positive funding evidence reopens an earlier explicitly unattempted expiry', async () => {
    const f = fixture();
    f.saved.purchaseAttempted = false;
    f.receipt.txHash = '';
    f.saved.terms = undefined;
    f.save();
    f.state.now = Date.parse(f.saved.request.payByTime) + 1;
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('expired_unfunded');
    f.saved.terms = f.terms;
    f.save();
    await f.next();
    expect(f.summary().status).toBe('recovery_required');
    expect(f.summary().lastVerifiedStatus).toBe('expired_unfunded');
    expect(f.summary().lastError).toBeUndefined();
    expect(f.summary().nextCheckAt).not.toBeNull();
  });

  test('wrong hashes, unknown states and invalid payouts retain verified historical facts', async () => {
    const f = fixture();
    await f.state.worker!.tick();
    f.deliver();
    f.setState('ResultSubmitted', {resultHash: 'ef'.repeat(32)});
    await f.next();
    expect(f.summary().status).toBe('recovery_required');
    expect(f.summary().lastVerifiedStatus).toBe('funds_locked');
    f.setState('FutureState');
    await f.next();
    expect(f.summary().status).toBe('unknown');
    expect(f.summary().lastVerifiedStatus).toBe('funds_locked');
    const payout = f.setState('Withdrawn');
    f.state.proofs.set(payout, {confirmed: false, confirmations: 100, reason: 'wrong escrow or beneficiary'});
    await f.next();
    expect(f.summary().status).toBe('withdrawal_pending');
    expect(f.summary().lastVerifiedStatus).toBe('funds_locked');
    expect(f.summary().nextCheckAt).not.toBeNull();
  });

  test('records a manual action error alongside independently verified money facts', async () => {
    const f = fixture();
    f.setState('FundsLocked', {nextAction: {requestedAction: 'SubmitResultRequested', errorType: 'Unknown'}});
    await f.state.worker!.tick();
    expect(f.summary().status).toBe('funds_locked');
    expect(f.summary().lastVerifiedStatus).toBe('funds_locked');
    expect(JSON.parse(f.observations().at(-1)!.evidenceJson).notes).toContain('Masumi action requires attention: Unknown');
  });

  test('does not query upstream for a receipt made by another configuration', async () => {
    const f = fixture();
    f.saved.configurationHash = 'different';
    f.save();
    await f.state.worker!.tick();
    expect(f.state.readCalls).toBe(0);
    expect(f.summary().lastError).toContain('operator reconciliation');
    expect(f.summary().nextCheckAt).not.toBeNull();
  });

  test('coalesces ticks and drains the in-flight observation before stop resolves', async () => {
    const f = fixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reading = new Promise<void>((resolve) => { entered = resolve; });
    f.state.readGate = async () => { entered(); await gate; };
    const first = f.state.worker!.tick();
    const second = f.state.worker!.tick();
    expect(first).toBe(second);
    await reading;
    let stopped = false;
    const stop = f.state.worker!.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    expect(await first).toBe(1);
    await stop;
    expect(f.observations()).toHaveLength(1);
    expect(await f.state.worker!.tick()).toBe(0);
  });
});
