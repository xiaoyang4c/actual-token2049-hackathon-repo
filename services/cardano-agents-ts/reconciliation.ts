import type {AgentStore, PaymentReceiptRecord, PaymentSettlementRecord, SettlementStatus} from '../../packages/db/src';
import type {CardanoAdapter} from './cardano';
import type {PaymentConfig} from './config';
import type {MasumiAdapter, MasumiSettlementSnapshot, MasumiSettlementTransaction, MasumiTerms} from './masumi';
import {session, type PaymentSession} from './runtime-protocol';
import {paymentConfigurationHash} from './runtime-setup';
import type {SettlementChainVerification} from './settlement-evidence';
import {PaymentError, sha256} from './types';

/** Deterministic clock and jitter injection also keep the fixture tests offline. */
export interface ReconciliationScheduleOptions {
  now?: () => number;
  random?: () => number;
  intervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  terminalCheckMs?: number;
  batchSize?: number;
  onError?: (error: unknown) => void;
}

export interface ReconcilerOptions extends ReconciliationScheduleOptions {
  store: AgentStore;
  config: PaymentConfig;
  cardano: CardanoAdapter;
  masumi: MasumiAdapter;
  runExclusive: (receiptId: string, run: () => Promise<void>) => Promise<void>;
}

interface ObservationEvidence {
  protocolVersion?: MasumiTerms['paymentSourceType'];
  expectedResultHash?: string;
  snapshot?: MasumiSettlementSnapshot;
  terminalSnapshot?: MasumiSettlementSnapshot;
  deposit?: {txHash: string; confirmed: boolean; confirmations: number; reason?: string};
  checks: SettlementChainVerification[];
  notes: string[];
}

interface ObservationOutcome {
  status: SettlementStatus;
  verified: boolean;
  error?: string;
  terminal?: boolean;
  wakeAt?: number;
}

const STATES = new Set([
  'FundsLocked', 'ResultSubmitted', 'Disputed', 'RefundRequested', 'WithdrawAuthorized',
  'RefundAuthorized', 'Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn', 'FundsOrDatumInvalid',
]);
const ACTIONS = new Set([
  'None', 'Ignore', 'WaitingForManualAction', 'WaitingForExternalAction',
  'SubmitResultRequested', 'SubmitResultInitiated', 'WithdrawRequested', 'WithdrawInitiated',
  'AuthorizeRefundRequested', 'AuthorizeRefundInitiated', 'FundsLockingRequested', 'FundsLockingInitiated',
  'SetRefundRequestedRequested', 'SetRefundRequestedInitiated', 'UnSetRefundRequestedRequested',
  'UnSetRefundRequestedInitiated', 'WithdrawRefundRequested', 'WithdrawRefundInitiated',
  'AuthorizeWithdrawalRequested', 'AuthorizeWithdrawalInitiated',
]);
const TERMINAL_STATES = new Set<SettlementStatus>(['withdrawn', 'refunded', 'disputed_settled', 'expired_unfunded']);

/** Reads upstream evidence. It never submits a transaction or changes delivery. */
export class PaymentReconciler {
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly intervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly terminalCheckMs: number;
  private readonly batchSize: number;
  private readonly configurationHash: string;
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<number>;
  private stopping = false;
  private initialized = false;

  constructor(private readonly options: ReconcilerOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.intervalMs = positiveInteger(options.intervalMs ?? 5_000, 'intervalMs');
    this.baseBackoffMs = positiveInteger(options.baseBackoffMs ?? 5_000, 'baseBackoffMs');
    this.maxBackoffMs = positiveInteger(options.maxBackoffMs ?? 15 * 60_000, 'maxBackoffMs');
    this.terminalCheckMs = positiveInteger(options.terminalCheckMs ?? 6 * 60 * 60_000, 'terminalCheckMs');
    this.batchSize = positiveInteger(options.batchSize ?? 25, 'batchSize');
    if (this.maxBackoffMs < this.baseBackoffMs) throw new PaymentError('maxBackoffMs must be at least baseBackoffMs');
    this.configurationHash = paymentConfigurationHash(options.config);
  }

  start(): void {
    if (this.timer || this.stopping) return;
    const poll = () => { void this.tick().catch((error: unknown) => {
      if (this.options.onError) this.options.onError(error);
      else console.error('Payment reconciliation could not persist a polling cycle');
    }); };
    this.timer = setInterval(poll, this.intervalMs);
    this.timer.unref?.();
    poll();
  }

  /** Drain the current cycle before its owner closes SQLite. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** Concurrent calls share one cycle. Durable due times control subsequent calls. */
  tick(): Promise<number> {
    if (this.stopping) return Promise.resolve(0);
    if (this.running) return this.running;
    const cycle = this.runCycle();
    this.running = cycle;
    void cycle.finally(() => { if (this.running === cycle) this.running = undefined; }).catch(() => {});
    return cycle;
  }

  private async runCycle(): Promise<number> {
    const {store, runExclusive} = this.options;
    if (!this.initialized) {
      // Includes receipts made before this migration and requests without delivery.
      for (const receipt of store.listPaymentReceipts()) store.ensurePaymentSettlement(receipt.receiptId, iso(this.now()));
      this.initialized = true;
    }
    const due = store.listDuePaymentSettlements(iso(this.now()), this.batchSize);
    let checked = 0;
    for (const queued of due) {
      if (this.stopping) break;
      await runExclusive(queued.receiptId, async () => {
        const summary = store.getPaymentSettlement(queued.receiptId);
        if (!summary?.nextCheckAt || Date.parse(summary.nextCheckAt) > this.now()) return;
        await this.observe(summary);
        checked++;
      });
    }
    return checked;
  }

  private async observe(summary: PaymentSettlementRecord): Promise<void> {
    const {store} = this.options;
    const evidence: ObservationEvidence = {checks: [], notes: []};
    let outcome: ObservationOutcome;
    try {
      const receipt = store.getPaymentReceipt(summary.receiptId);
      if (!receipt) throw new PaymentError('settlement receipt is missing');
      const saved = this.validateSession(receipt);
      evidence.protocolVersion = saved.request.paymentSourceType;
      evidence.expectedResultHash = receipt.resultHash;
      outcome = await this.interpret(receipt, saved, summary, evidence);
    } catch (error) {
      outcome = {
        status: 'recovery_required', verified: false,
        error: error instanceof PaymentError ? error.message : 'settlement observation failed; retry is scheduled',
      };
    }
    const at = this.now();
    let delay = outcome.terminal ? this.terminalCheckMs : this.backoff(summary.attemptCount);
    if (outcome.wakeAt !== undefined && outcome.wakeAt > at) delay = Math.min(delay, outcome.wakeAt - at);
    store.recordPaymentSettlementObservation({
      receiptId: summary.receiptId, observedAt: iso(at), status: outcome.status,
      verified: outcome.verified, evidenceJson: JSON.stringify(evidence), error: outcome.error,
      nextCheckAt: iso(at + Math.max(1, delay)),
    });
  }

  private validateSession(receipt: PaymentReceiptRecord): PaymentSession {
    const {config, cardano, masumi} = this.options;
    const saved = session(receipt);
    if (!saved || typeof saved !== 'object' || !saved.request ||
        saved.configurationHash !== this.configurationHash || saved.mode !== config.mode ||
        receipt.network !== config.network || receipt.payer !== config.walletAddress ||
        receipt.simulated !== cardano.simulated || cardano.simulated !== masumi.simulated ||
        saved.request.network !== 'Preprod' || saved.request.forceLayer !== 'L1' ||
        saved.request.agentIdentifier !== config.masumiAgentIdentifier ||
        saved.request.paymentSourceType !== config.masumiPaymentSourceType ||
        (saved.request.paymentSourceType === 'Web3CardanoV2' &&
          saved.request.supportedPaymentSourceIndex !== config.masumiSupportedSourceIndex) ||
        (receipt.inputHash !== undefined && saved.request.inputHash !== receipt.inputHash) ||
        saved.request.sellerReturnAddress !== receipt.payTo) {
      throw new PaymentError('receipt configuration requires operator reconciliation');
    }
    if (receipt.resultHash && (!/^[a-f0-9]{64}$/.test(receipt.resultHash) ||
        (receipt.responseJson && sha256(receipt.responseJson) !== receipt.resultHash))) {
      throw new PaymentError('stored response does not match the expected result hash');
    }
    if (saved.terms && (saved.terms.inputHash !== saved.request.inputHash ||
        saved.terms.agentIdentifier !== saved.request.agentIdentifier ||
        saved.terms.identifierFromPurchaser !== saved.request.identifierFromPurchaser ||
        saved.terms.paymentSourceType !== saved.request.paymentSourceType ||
        saved.terms.supportedPaymentSourceIndex !== saved.request.supportedPaymentSourceIndex ||
        (saved.terms.sellerReturnAddress !== undefined && saved.terms.sellerReturnAddress !== receipt.payTo) ||
        saved.terms.amountLovelace !== receipt.amount || !saved.terms.blockchainIdentifier ||
        !saved.terms.escrowAddress.startsWith('addr_test1'))) throw new PaymentError('stored Masumi terms require operator reconciliation');
    for (const name of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const) {
      const requested = timestamp(saved.request[name]);
      if (saved.terms && timestamp(saved.terms[name]) !== requested) {
        throw new PaymentError('stored Masumi deadlines require operator reconciliation');
      }
    }
    return saved;
  }

  private async interpret(
    receipt: PaymentReceiptRecord, saved: PaymentSession, previous: PaymentSettlementRecord,
    evidence: ObservationEvidence,
  ): Promise<ObservationOutcome> {
    const payBy = timestamp(saved.terms?.payByTime ?? saved.request.payByTime);
    if (!saved.terms) return this.noFunding(receipt, saved, payBy, evidence);
    const terms = saved.terms;
    const snapshot = await this.options.masumi.getSettlement(terms);
    evidence.snapshot = snapshot;
    if (snapshot.protocolFeeError) evidence.notes.push(snapshot.protocolFeeError);
    const views = [snapshot.payment, snapshot.purchase].filter((view) => view !== null);
    const states = new Set(views.map((view) => view.onChainState).filter((state): state is string => state !== null));
    const transactions = views.flatMap((view) => view.transactions);
    const actions = views.flatMap((view) => !view.nextAction?.errorType && view.nextAction?.requestedAction
      ? [view.nextAction.requestedAction] : []);
    const actionError = views.find((view) => view.nextAction?.errorType)?.nextAction;
    if (actionError?.errorType) evidence.notes.push(`Masumi action requires attention: ${actionError.errorType}`);
    if (actions.includes('WaitingForManualAction')) evidence.notes.push('Masumi is waiting for a manual action');
    const priorTerminal = this.previousTerminalSnapshot(previous);
    if (priorTerminal) {
      const state = priorTerminal.status === 'withdrawn' ? 'Withdrawn' : priorTerminal.status === 'refunded'
        ? 'RefundWithdrawn' : 'DisputedWithdrawn';
      const kind = priorTerminal.status === 'withdrawn' ? 'withdrawal' : priorTerminal.status === 'refunded'
        ? 'refund' : 'disputed_withdrawal';
      if (await this.verifyCandidate(receipt, terms, priorTerminal.snapshot,
        [priorTerminal.snapshot.payment, priorTerminal.snapshot.purchase].flatMap((view) => view?.transactions ?? []),
        [state], kind, priorTerminal.depositTxHash, evidence)) {
        evidence.terminalSnapshot = priorTerminal.snapshot;
        evidence.deposit = {txHash: priorTerminal.depositTxHash, confirmed: true,
          confirmations: this.options.config.minimumConfirmations};
        evidence.notes.push('Previously confirmed settlement remains confirmed despite the latest upstream observation');
        return {status: priorTerminal.status, verified: true, terminal: true};
      }
      evidence.notes.push('Previously confirmed settlement lost confirmation; its reconciliation is reopened');
    }
    if (actions.some((action) => !ACTIONS.has(action))) {
      return attention('unknown', 'Unknown Masumi action requires a protocol mapping', evidence);
    }
    if ([...states].some((state) => !STATES.has(state))) {
      return attention('unknown', 'Unknown Masumi state requires a protocol mapping', evidence);
    }
    if (terms.paymentSourceType === 'Web3CardanoV1' &&
        (states.has('WithdrawAuthorized') || states.has('RefundAuthorized'))) {
      return attention('recovery_required', 'V2 authorization state reported for a V1 payment', evidence);
    }
    if (states.has('FundsOrDatumInvalid')) {
      return attention('recovery_required', 'Masumi reported invalid funds or datum', evidence);
    }
    const terminal = ['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn'].filter((state) => states.has(state));
    if (terminal.length > 1) {
      return attention('recovery_required', 'Masumi returned contradictory terminal states', evidence);
    }
    const deposit = receipt.txHash || transactions.find((tx) => tx.newOnChainState === 'FundsLocked')?.txHash;
    if (deposit) {
      const verification = await this.options.cardano.verifyPayment({
        txHash: deposit, payTo: terms.escrowAddress, amountLovelace: receipt.amount,
      });
      evidence.deposit = {txHash: deposit, ...verification};
    }
    if (terminal.length) return this.terminal(receipt, terms, snapshot, transactions, terminal[0], deposit, previous, evidence);
    if (!evidence.deposit?.confirmed) {
      if (states.size || deposit) return {status: 'pending', verified: false};
      return this.noFunding(receipt, saved, payBy, evidence);
    }
    if (saved.purchaseAttempted === false) {
      return attention('recovery_required', 'Funding evidence contradicts the saved purchase boundary', evidence);
    }
    if (!states.size) {
      return attention(this.now() > payBy ? 'recovery_required' : 'pending',
        'The deposit is confirmed but the current escrow state is unavailable', evidence);
    }
    const observedHashes = views.map((view) => view.resultHash).filter((hash): hash is string => Boolean(hash));
    const queuedHashes = views.map((view) => view.nextAction?.resultHash).filter((hash): hash is string => Boolean(hash));
    // Authorizing a refund clears the result hash in both protocol versions.
    const mismatched = [...observedHashes, ...queuedHashes].some((hash) => hash !== receipt.resultHash);
    if (mismatched) return attention('recovery_required', 'Masumi result hash does not match the stored response', evidence);
    let currentState: string | undefined;
    let stateConfirmed = false;
    let currentResultHash: string | null | undefined;
    for (const candidate of ['RefundAuthorized', 'Disputed', 'RefundRequested', 'FundsLocked']) {
      if (!states.has(candidate)) continue;
      currentState ??= candidate;
      const proof = deposit && await this.verifyCandidate(receipt, terms, snapshot, transactions, [candidate], 'state', deposit, evidence);
      if (proof) {
        currentState = candidate;
        stateConfirmed = true;
        currentResultHash = proof.resultHash;
        break;
      }
    }
    if (currentState && !stateConfirmed && !states.has('ResultSubmitted') && !states.has('WithdrawAuthorized')) {
      return {status: currentState === 'Disputed' ? 'disputed' : currentState === 'RefundAuthorized'
        ? 'refund_authorized' : currentState === 'RefundRequested' ? 'refund_requested' : 'funds_locked', verified: false};
    }
    // V2 authorization clears the result hash and allows immediate collection.
    if (currentState === 'RefundAuthorized' && stateConfirmed) return {status: 'refund_available', verified: true};
    if (actions.some((action) => ['WithdrawRefundRequested', 'WithdrawRefundInitiated'].includes(action))) {
      return {status: 'refund_pending', verified: false};
    }
    if (currentState === 'Disputed' && stateConfirmed) return {status: 'disputed', verified: true,
      wakeAt: timestamp(terms.externalDisputeUnlockTime) + 1};
    const submitBy = timestamp(terms.submitResultTime);
    if (stateConfirmed && currentResultHash === null &&
        (currentState === 'FundsLocked' || currentState === 'RefundRequested') && this.now() > submitBy) {
      return {status: 'refund_available', verified: true};
    }
    if ((currentState === 'RefundRequested' && stateConfirmed) || receipt.status === 'refund_requested' ||
        actions.some((action) => action.startsWith('SetRefundRequested'))) {
      return {status: 'refund_requested', verified: currentState === 'RefundRequested' && stateConfirmed,
        wakeAt: futureTime([String(submitBy + 1), ...views.map((view) => view.buyerCoolDownTime)], this.now())};
    }
    if (states.has('WithdrawAuthorized') || states.has('ResultSubmitted')) {
      if (!receipt.resultHash || !deposit) return attention('recovery_required',
        'Result state has no expected locally stored result', evidence);
      let provenResultState: string | undefined;
      for (const candidate of ['WithdrawAuthorized', 'ResultSubmitted']) {
        if (states.has(candidate) && await this.verifyCandidate(receipt, terms, snapshot, transactions,
          [candidate], 'result', deposit, evidence)) {
          provenResultState = candidate;
          break;
        }
      }
      if (!provenResultState) return {status: 'result_queued', verified: false};
      if (actions.some((action) => ['WithdrawRequested', 'WithdrawInitiated'].includes(action))) {
        return {status: 'withdrawal_pending', verified: false};
      }
      const unlock = timestamp(terms.unlockTime);
      if (provenResultState === 'WithdrawAuthorized' || this.now() > unlock) return {status: 'withdrawal_available', verified: true};
      return {status: 'result_confirmed', verified: true, wakeAt: unlock + 1};
    }
    if (!actionError && receipt.resultHash && (saved.resultQueued || queuedHashes.includes(receipt.resultHash) ||
        actions.some((action) => action.startsWith('SubmitResult')))) return {status: 'result_queued', verified: false,
          wakeAt: futureTime(views.map((view) => view.sellerCoolDownTime), this.now())};
    return {status: 'funds_locked', verified: true, wakeAt: submitBy + 1};
  }

  private previousTerminalSnapshot(previous: PaymentSettlementRecord): {
    status: SettlementStatus; snapshot: MasumiSettlementSnapshot; depositTxHash: string;
  } | undefined {
    const status = previous.lastVerifiedStatus ?? previous.status;
    if (!TERMINAL_STATES.has(status) || status === 'expired_unfunded') return;
    const observation = this.options.store.getLastVerifiedPaymentSettlementObservation(previous.receiptId, status);
    if (!observation) return;
    const value = JSON.parse(observation.evidenceJson) as Partial<ObservationEvidence>;
    const snapshot = value.terminalSnapshot ?? value.snapshot;
    const depositTxHash = value.deposit?.txHash;
    if (snapshot && depositTxHash) return {status, snapshot, depositTxHash};
    return;
  }

  private noFunding(
    receipt: PaymentReceiptRecord, saved: PaymentSession, payBy: number, evidence: ObservationEvidence,
  ): ObservationOutcome {
    if (this.now() <= payBy) return {status: 'pending',
      verified: saved.purchaseAttempted === false && !receipt.txHash, wakeAt: payBy + 1};
    if (saved.purchaseAttempted === false && !receipt.txHash) {
      return {status: 'expired_unfunded', verified: true, terminal: true};
    }
    return attention('recovery_required',
      'Expired request may have locked funds; absence of an upstream record is insufficient', evidence);
  }

  private async terminal(
    receipt: PaymentReceiptRecord, terms: MasumiTerms, snapshot: MasumiSettlementSnapshot,
    transactions: MasumiSettlementTransaction[], state: string, deposit: string | undefined,
    previous: PaymentSettlementRecord, evidence: ObservationEvidence,
  ): Promise<ObservationOutcome> {
    const status: SettlementStatus = state === 'Withdrawn' ? 'withdrawn' :
      state === 'RefundWithdrawn' ? 'refunded' : 'disputed_settled';
    const pending: SettlementStatus = state === 'RefundWithdrawn' ? 'refund_pending' : 'withdrawal_pending';
    const kind = state === 'Withdrawn' ? 'withdrawal' : state === 'RefundWithdrawn' ? 'refund' : 'disputed_withdrawal';
    if (deposit && await this.verifyCandidate(receipt, terms, snapshot, transactions, [state], kind, deposit, evidence)) {
      evidence.terminalSnapshot = snapshot;
      return {status, verified: true, terminal: true};
    }
    // A successful lookup that lost confirmation reopens an earlier terminal state.
    // Transport failures throw before here and retain the last verified state.
    if (TERMINAL_STATES.has(previous.status) && evidence.checks.length) {
      evidence.notes.push('The terminal transaction is no longer confirmed; reconciliation remains scheduled');
      return {status: pending, verified: false};
    }
    return {status: pending, verified: false};
  }

  private async verifyCandidate(
    receipt: PaymentReceiptRecord, terms: MasumiTerms, snapshot: MasumiSettlementSnapshot,
    transactions: MasumiSettlementTransaction[], states: string[],
    kind: 'state' | 'result' | 'withdrawal' | 'refund' | 'disputed_withdrawal', depositTxHash: string,
    evidence: ObservationEvidence,
  ): Promise<SettlementChainVerification | undefined> {
    const seen = new Set<string>();
    for (const transaction of transactions.filter((tx) => states.includes(tx.newOnChainState ?? ''))) {
      if (!transaction.txHash || seen.has(transaction.txHash)) continue;
      if (seen.size >= 8) {
        evidence.notes.push('Too many candidate transactions to verify in one reconciliation check');
        return;
      }
      seen.add(transaction.txHash);
      const view = [snapshot.payment, snapshot.purchase].find((candidate) =>
        candidate?.transactions.some((tx) => tx.txHash === transaction.txHash && tx.newOnChainState === transaction.newOnChainState));
      const check = await this.options.cardano.verifySettlement({
        terms, depositTxHash, transaction, kind, resultHash: receipt.resultHash,
        sellerAddress: receipt.payTo, buyerAddress: receipt.payer,
        withdrawnForSeller: view?.withdrawnForSeller, withdrawnForBuyer: view?.withdrawnForBuyer,
        protocolFees: snapshot.protocolFees,
      });
      evidence.checks.push(check);
      if (check.confirmed) return check;
    }
    return;
  }

  private backoff(attemptCount: number): number {
    const exponential = Math.min(this.maxBackoffMs, this.baseBackoffMs * 2 ** Math.min(30, Math.max(0, attemptCount)));
    const random = this.random();
    const jitter = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5;
    return Math.max(1, Math.floor(Math.min(this.maxBackoffMs, exponential * (0.8 + jitter * 0.4))));
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new PaymentError(`${label} must be a positive integer`);
  return value;
}

function timestamp(value: string): number {
  const time = /^[0-9]+$/.test(value) ? Number(value) : Date.parse(value);
  if (!Number.isSafeInteger(time) || time < 0) throw new PaymentError('invalid protocol deadline requires operator reconciliation');
  return time;
}

function futureTime(values: (string | undefined)[], now: number): number | undefined {
  const times = values.filter((value): value is string => value !== undefined).map(timestamp).filter((time) => time > now);
  return times.length ? Math.min(...times) : undefined;
}

function attention(status: SettlementStatus, note: string, evidence: ObservationEvidence): ObservationOutcome {
  evidence.notes.push(note);
  return {status, verified: false};
}

function iso(value: number): string { return new Date(value).toISOString(); }
