/**
 * @fileoverview Paper escrow for the contract lifecycle. It models the
 * Masumi V2 contract and the payment service automatic jobs. It sends
 * nothing to a chain. Every reference and transaction id starts with
 * `paper-` and is never a 64-character hex string, so it cannot pass as a
 * Cardano transaction hash.
 *
 * Not modelled: buyer and seller cooldowns, fees, min-UTxO ADA, and
 * FundsOrDatumInvalid.
 */

import {randomBytes} from 'node:crypto';
import type {AgentStore} from '../../packages/db/src/index';
import {
  EscrowRejectedError, EscrowRetryableError, type ContractClock, type ContractEscrow,
  type EscrowRequest, type EscrowResult, type EscrowStatus,
} from '../../packages/reliability/src/contract-lifecycle/ports';
import type {ConfirmedEscrowTransition, Deadlines, OnChainState} from '../../packages/reliability/src/contract-lifecycle/types';

export interface PaperEscrowOptions {
  /** Simulated time from submission to confirmation. */
  confirmationDelayMs: number;
  /** MPS waits this long after unlockTime before it withdraws (10 minutes in MPS). */
  autoWithdrawDelayMs: number;
}

interface PaperTx {
  kind: string;
  to: OnChainState;
  txId: string;
  confirmAt: number;
  resultHash?: string|null;
}

interface PaperEscrowRecord {
  ref: string;
  amountAtomic: string;
  deadlines: Deadlines;
  state: OnChainState|null;
  resultHash: string|null;
  pendingTx: PaperTx|null;
  lastTxId: string|null;
  paidToSellerAtomic: string|null;
  paidToBuyerAtomic: string|null;
  settlementTxId: string|null;
  log: Array<ConfirmedEscrowTransition & {kind: string; txId: string}>;
}

const PREFIX = 'paper-';
// Confirm one transaction, then at most one automatic follow-up, and repeat.
// The longest real chain is confirm, automatic job, confirm. The bound only stops a model bug.
const MAX_ADVANCE_STEPS = 4;

export class PaperContractEscrow implements ContractEscrow {
  readonly mode = 'paper' as const;

  constructor(
    private readonly store: AgentStore,
    private readonly clock: ContractClock,
    private readonly options: PaperEscrowOptions,
  ) {}

  async execute(request: EscrowRequest): Promise<EscrowResult> {
    const applied = this.store.getPaperEscrowOp(request.idempotencyKey);
    if (applied) return {ref: applied}; // the same key never applies twice

    if (request.kind === 'create_terms') {
      const ref = `${PREFIX}pay-${randomBytes(12).toString('hex')}`;
      const deadlines = request.payload.deadlines as Deadlines;
      const record: PaperEscrowRecord = {
        ref,
        amountAtomic: String(request.payload.amountAtomic),
        deadlines,
        state: null,
        resultHash: null,
        pendingTx: null,
        lastTxId: null,
        paidToSellerAtomic: null,
        paidToBuyerAtomic: null,
        settlementTxId: null,
        log: [],
      };
      this.save(record, request);
      return {
        ref,
        terms: {
          blockchainIdentifier: ref,
          amountAtomic: record.amountAtomic,
          unit: String(request.payload.assetUnit),
          payByTime: String(deadlines.payByTime),
          submitResultTime: String(deadlines.submitResultTime),
          unlockTime: String(deadlines.unlockTime),
          externalDisputeUnlockTime: String(deadlines.externalDisputeUnlockTime),
          mode: 'paper',
        },
      };
    }

    const record = this.load(request.ref);
    this.advance(record);
    if (record.pendingTx) {
      this.save(record);
      throw new EscrowRetryableError(`paper escrow ${record.ref} has a transaction in flight`);
    }
    const now = this.clock.now();
    const deadlines = record.deadlines;
    const reject = (why: string): never => {
      this.save(record);
      throw new EscrowRejectedError(`${request.kind} rejected on ${record.ref}: ${why}`);
    };

    switch (request.kind) {
      case 'lock_funds':
        if (record.state !== null) reject('the escrow is already funded');
        if (now >= deadlines.payByTime) reject('payByTime has passed');
        this.schedule(record, 'Lock', 'FundsLocked');
        break;
      case 'submit_result': {
        const hash = String(request.payload.resultHash ?? '');
        if (!/^[0-9a-f]{64}$/.test(hash)) reject('resultHash must be 64 hex characters');
        if (record.state === 'FundsLocked' || record.state === 'ResultSubmitted') {
          if (now >= deadlines.submitResultTime) reject('submitResultTime has passed');
          this.schedule(record, 'SubmitResult', 'ResultSubmitted', hash);
        } else if (record.state === 'RefundRequested') {
          if (now >= deadlines.submitResultTime) reject('submitResultTime has passed');
          this.schedule(record, 'SubmitResult', 'Disputed', hash);
        } else if (record.state === 'Disputed') {
          if (now >= deadlines.externalDisputeUnlockTime) reject('externalDisputeUnlockTime has passed');
          this.schedule(record, 'SubmitResult', 'Disputed', hash);
        } else {
          reject(`SubmitResult is not allowed from ${String(record.state)}`);
        }
        break;
      }
      case 'request_refund':
        if (record.state !== 'FundsLocked' && record.state !== 'ResultSubmitted') {
          reject(`SetRefundRequested is not allowed from ${String(record.state)}`);
        }
        if (now >= deadlines.unlockTime) reject('unlockTime has passed');
        this.schedule(record, 'SetRefundRequested', record.resultHash ? 'Disputed' : 'RefundRequested');
        break;
      case 'authorize_withdrawal':
        if (record.state !== 'Disputed') reject(`AuthorizeWithdrawal is allowed from Disputed only, not ${String(record.state)}`);
        this.schedule(record, 'AuthorizeWithdrawal', 'WithdrawAuthorized');
        break;
      case 'authorize_refund':
        if (!['RefundRequested', 'Disputed'].includes(record.state ?? '')) {
          reject(`AuthorizeRefund is not allowed from ${String(record.state)}`);
        }
        this.schedule(record, 'AuthorizeRefund', 'RefundAuthorized', null);
        break;
      default:
        reject(`unknown operation ${String(request.kind)}`);
    }
    this.save(record, request);
    return {ref: record.ref};
  }

  async inspect(request: EscrowRequest): Promise<EscrowResult&{status: 'applied'|'not_applied'|'unknown'}> {
    const ref = this.store.getPaperEscrowOp(request.idempotencyKey);
    return ref ? {status: 'applied', ref} : {status: 'not_applied'};
  }

  async status(ref: string): Promise<EscrowStatus> {
    const record = this.load(ref);
    this.advance(record);
    this.save(record);
    return {
      onChainState: record.state,
      confirmed: record.pendingTx === null,
      lastTxHash: record.lastTxId,
      resultHash: record.resultHash,
      paidToSellerAtomic: record.paidToSellerAtomic,
      paidToBuyerAtomic: record.paidToBuyerAtomic,
      settlementTxHash: record.settlementTxId,
      history: record.log.map(({at, from, to, resultHash}) => ({at, from, to, resultHash})),
    };
  }

  /** Test and demo hook: the Masumi admins settle a disputed escrow. */
  simulateAdminSettlement(ref: string, toBuyerAtomic: string, toSellerAtomic: string): void {
    const record = this.load(ref);
    this.advance(record);
    if (record.state !== 'Disputed' || record.pendingTx) throw new Error('admin settlement needs a confirmed Disputed escrow');
    if (this.clock.now() < record.deadlines.externalDisputeUnlockTime) {
      throw new Error('the admins can act only after externalDisputeUnlockTime');
    }
    const txId = this.newTxId();
    record.log.push({at: this.clock.now(), kind: 'WithdrawDisputed', from: record.state, to: 'DisputedWithdrawn', txId});
    record.state = 'DisputedWithdrawn';
    record.lastTxId = txId;
    record.settlementTxId = txId;
    record.paidToBuyerAtomic = toBuyerAtomic;
    record.paidToSellerAtomic = toSellerAtomic;
    this.save(record);
  }

  /** The kind of the transaction in flight, or null. The fake payment service reports it as NextAction. */
  pendingTransaction(ref: string): string|null {
    const record = this.load(ref);
    this.advance(record);
    this.save(record);
    return record.pendingTx?.kind ?? null;
  }

  /** Every paper transaction of one escrow. Tests use it to prove a write was sent once. */
  transactionLog(ref: string): PaperEscrowRecord['log'] {
    return this.load(ref).log;
  }

  private newTxId(): string {
    return `${PREFIX}tx-${randomBytes(12).toString('hex')}`;
  }

  private schedule(record: PaperEscrowRecord, kind: string, to: OnChainState, resultHash?: string|null): void {
    record.pendingTx = {kind, to, txId: this.newTxId(), confirmAt: this.clock.now() + this.options.confirmationDelayMs, resultHash};
  }

  /** Confirms due transactions and runs the MPS automatic jobs. */
  private advance(record: PaperEscrowRecord): void {
    for (let step = 0; step < MAX_ADVANCE_STEPS; step++) {
      const now = this.clock.now();
      if (record.pendingTx) {
        if (now < record.pendingTx.confirmAt) return;
        const tx = record.pendingTx;
        record.log.push({at: tx.confirmAt, kind: tx.kind, from: record.state, to: tx.to, txId: tx.txId, resultHash: tx.resultHash});
        record.state = tx.to;
        record.lastTxId = tx.txId;
        if (tx.resultHash !== undefined) record.resultHash = tx.resultHash;
        if (tx.to === 'Withdrawn') {
          record.paidToSellerAtomic = record.amountAtomic;
          record.paidToBuyerAtomic = '0';
          record.settlementTxId = tx.txId;
        }
        if (tx.to === 'RefundWithdrawn') {
          record.paidToBuyerAtomic = record.amountAtomic;
          record.paidToSellerAtomic = '0';
          record.settlementTxId = tx.txId;
        }
        record.pendingTx = null;
      }
      const deadlines = record.deadlines;
      const delay = this.options.autoWithdrawDelayMs;
      if (record.state === 'WithdrawAuthorized' ||
          (record.state === 'ResultSubmitted' && now >= deadlines.unlockTime + delay)) {
        this.schedule(record, 'Withdraw', 'Withdrawn');
      } else if (record.state === 'RefundAuthorized' ||
          ((record.state === 'FundsLocked' || record.state === 'RefundRequested') && now >= deadlines.submitResultTime + delay)) {
        this.schedule(record, 'WithdrawRefund', 'RefundWithdrawn');
      } else {
        return;
      }
    }
  }

  private load(ref: string|null): PaperEscrowRecord {
    if (!ref) throw new EscrowRejectedError('the escrow reference is missing');
    const json = this.store.getPaperEscrow(ref);
    if (!json) throw new EscrowRejectedError(`unknown paper escrow ${ref}`);
    return JSON.parse(json) as PaperEscrowRecord;
  }

  private save(record: PaperEscrowRecord, applied?: EscrowRequest): void {
    this.store.savePaperEscrow(record.ref, JSON.stringify(record), applied ? {
      idempotencyKey: applied.idempotencyKey, kind: applied.kind, appliedAt: this.clock.now(),
    } : undefined);
  }
}
