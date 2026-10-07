/**
 * @fileoverview Fake Masumi payment service (MPS) for adapter tests.
 * It speaks the MPS V2 JSON shapes (rev d569a33) over an ApiTransport and
 * applies the MPS validation rules that the adapter must respect. The V2
 * state machine underneath is the paper escrow. It is marked simulated,
 * so contracts that use it stay labelled paper.
 */

import {randomUUID} from 'node:crypto';
import {AgentStore} from '../../packages/db/src/index';
import {MPS_DEADLINE_RULES} from '../../packages/reliability/src/contract-lifecycle/deadlines';
import {isIdentifierFromPurchaser} from '../../packages/reliability/src/contract-lifecycle/hashing';
import {EscrowRejectedError, type ContractClock, type EscrowOpKind} from '../../packages/reliability/src/contract-lifecycle/ports';
import type {Deadlines} from '../../packages/reliability/src/contract-lifecycle/types';
import type {ApiTransport} from '../cardano-agents-ts/types';
import {PaperContractEscrow} from './contract-paper-escrow';

/** MPS NextAction names while a transaction is in flight. */
const IN_FLIGHT: {[paperKind: string]: {side: 'buyer'|'seller'; action: string}} = {
  Lock: {side: 'buyer', action: 'FundsLockingInitiated'},
  SubmitResult: {side: 'seller', action: 'SubmitResultInitiated'},
  SetRefundRequested: {side: 'buyer', action: 'SetRefundRequestedInitiated'},
  AuthorizeWithdrawal: {side: 'buyer', action: 'AuthorizeWithdrawalInitiated'},
  AuthorizeRefund: {side: 'seller', action: 'AuthorizeRefundInitiated'},
  Withdraw: {side: 'seller', action: 'WithdrawInitiated'},
  WithdrawRefund: {side: 'buyer', action: 'WithdrawRefundInitiated'},
};

interface PaymentRecord {
  blockchainIdentifier: string;
  paperRef: string;
  inputHash: string;
  agentIdentifier: string;
  unit: string;
  amount: string;
  deadlines: Deadlines;
  purchased: boolean;
}

export interface RecordedCall {
  path: string;
  body: {[key: string]: unknown};
}

export class FakeMps {
  readonly calls: RecordedCall[] = [];
  readonly transport: ApiTransport;
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly paper: PaperContractEscrow;
  /** Paths whose next call succeeds on the service but then fails the HTTP response. */
  private readonly dropResponse = new Set<string>();

  constructor(private readonly clock: ContractClock, confirmationDelayMs = 3_000, autoWithdrawDelayMs = 30_000) {
    this.paper = new PaperContractEscrow(AgentStore.open(':memory:'), clock, {confirmationDelayMs, autoWithdrawDelayMs});
    this.transport = {simulated: true, fetch: (url, init) => this.handle(url, init)};
  }

  /** The next call to `path` is applied, then the response is lost (a timeout after success). */
  loseNextResponse(path: string): void {
    this.dropResponse.add(path);
  }

  count(path: string): number {
    return this.calls.filter((call) => call.path === path).length;
  }

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    const body = JSON.parse(String(init.body ?? '{}')) as {[key: string]: unknown};
    this.calls.push({path, body});
    let response: Response;
    try {
      response = await this.route(path, body);
    } catch (error) {
      response = respond(error instanceof EscrowRejectedError ? 400 : 503, {status: 'error', error: String(error)});
    }
    if (this.dropResponse.delete(path)) throw new Error('socket closed');
    return response;
  }

  private async route(path: string, body: {[key: string]: unknown}): Promise<Response> {
    if (path === '/payment') return this.createPayment(body);
    const record = this.payments.get(String(body.blockchainIdentifier));
    if (path === '/payment/resolve-blockchain-identifier') {
      return record ? ok(await this.view(record, 'seller')) : respond(404, {status: 'error'});
    }
    if (path === '/purchase/resolve-blockchain-identifier') {
      return record?.purchased ? ok(await this.view(record, 'buyer')) : respond(404, {status: 'error'});
    }
    if (!record) return respond(404, {status: 'error'});
    if (path === '/purchase') return this.purchase(record, body);
    const kinds: {[route: string]: EscrowOpKind} = {
      '/payment/submit-result': 'submit_result',
      '/purchase/request-refund': 'request_refund',
      '/purchase/cancel-refund-request': 'authorize_withdrawal',
      '/payment/authorize-refund': 'authorize_refund',
    };
    const kind = kinds[path];
    if (!kind) return respond(404, {status: 'error'});
    const status = await this.paper.status(record.paperRef);
    const allowed: Partial<Record<EscrowOpKind, string[]>> = {
      authorize_refund: ['RefundRequested', 'Disputed'],
      authorize_withdrawal: ['Disputed'],
      submit_result: ['FundsLocked', 'RefundRequested', 'Disputed'],
      request_refund: ['FundsLocked', 'ResultSubmitted'],
    };
    if (!allowed[kind]?.includes(status.onChainState ?? '')) return respond(404, {status: 'error'});
    await this.paper.execute({
      kind, idempotencyKey: randomUUID(), ref: record.paperRef, terms: null,
      payload: {resultHash: body.submitResultHash},
    });
    return ok(await this.view(record, kind === 'submit_result' || kind === 'authorize_refund' ? 'seller' : 'buyer'));
  }

  private async createPayment(body: {[key: string]: unknown}): Promise<Response> {
    const funds = body.RequestedFunds as Array<{amount: string; unit: string}>|undefined;
    const fund = funds?.[0];
    if (!fund || funds.length !== 1) return respond(400, {status: 'error', error: 'one RequestedFunds entry required'});
    if (!isIdentifierFromPurchaser(String(body.identifierFromPurchaser))) return respond(400, {status: 'error', error: 'identifierFromPurchaser must be 14-26 hex'});
    const time = (name: string) => Date.parse(String(body[name]));
    const deadlines: Deadlines = {
      payByTime: time('payByTime'), submitResultTime: time('submitResultTime'),
      unlockTime: time('unlockTime'), externalDisputeUnlockTime: time('externalDisputeUnlockTime'),
    };
    const now = this.clock.now();
    const rules = MPS_DEADLINE_RULES;
    if (deadlines.payByTime > deadlines.submitResultTime - rules.payByBeforeSubmitResultMinMs ||
        deadlines.submitResultTime < now + rules.submitResultFromNowMinMs ||
        deadlines.unlockTime < deadlines.submitResultTime + rules.unlockAfterSubmitResultMinMs ||
        deadlines.externalDisputeUnlockTime < deadlines.unlockTime + rules.externalDisputeAfterUnlockMinMs) {
      return respond(400, {status: 'error', error: 'deadlines violate the MPS rules'});
    }
    const paper = await this.paper.execute({
      kind: 'create_terms', idempotencyKey: randomUUID(), ref: null, terms: null,
      payload: {amountAtomic: fund.amount, assetUnit: fund.unit, deadlines},
    });
    const record: PaymentRecord = {
      blockchainIdentifier: `bcid-${randomUUID()}`,
      paperRef: String(paper.ref),
      inputHash: String(body.inputHash),
      agentIdentifier: String(body.agentIdentifier),
      unit: fund.unit,
      amount: fund.amount,
      deadlines,
      purchased: false,
    };
    this.payments.set(record.blockchainIdentifier, record);
    return ok(await this.view(record, 'seller'));
  }

  private async purchase(record: PaymentRecord, body: {[key: string]: unknown}): Promise<Response> {
    const amounts = body.Amounts as Array<{amount: string; unit: string}>|undefined;
    if (amounts?.[0]?.unit !== record.unit || amounts[0].amount !== record.amount || body.inputHash !== record.inputHash) {
      return respond(400, {status: 'error', error: 'purchase does not match the signed payment'});
    }
    if (String(body.unlockTime) !== String(record.deadlines.unlockTime)) {
      return respond(400, {status: 'error', error: 'times must be the signed unix ms strings'});
    }
    if (record.purchased) return respond(409, {status: 'error', object: await this.view(record, 'buyer')});
    await this.paper.execute({kind: 'lock_funds', idempotencyKey: randomUUID(), ref: record.paperRef, terms: null, payload: {}});
    record.purchased = true;
    return ok(await this.view(record, 'buyer'));
  }

  private async view(record: PaymentRecord, side: 'buyer'|'seller'): Promise<{[key: string]: unknown}> {
    const status = await this.paper.status(record.paperRef);
    const inFlight = this.paper.pendingTransaction(record.paperRef);
    const flight = inFlight ? IN_FLIGHT[inFlight] : undefined;
    const action = flight && flight.side === side ? flight.action : 'WaitingForExternalAction';
    const funds = [{amount: record.amount, unit: record.unit}];
    const log = this.paper.transactionLog(record.paperRef);
    return {
      blockchainIdentifier: record.blockchainIdentifier,
      agentIdentifier: record.agentIdentifier,
      inputHash: record.inputHash,
      onChainState: status.onChainState,
      resultHash: status.resultHash,
      payByTime: String(record.deadlines.payByTime),
      submitResultTime: String(record.deadlines.submitResultTime),
      unlockTime: String(record.deadlines.unlockTime),
      externalDisputeUnlockTime: String(record.deadlines.externalDisputeUnlockTime),
      forceLayer: null,
      sellerReturnAddress: null,
      NextAction: {requestedAction: action, errorType: null},
      CurrentTransaction: inFlight ? {txHash: null, status: 'Pending'} : (status.lastTxHash ? {txHash: status.lastTxHash, status: 'Confirmed'} : null),
      TransactionHistory: log.map((tx) => ({txHash: tx.txId, status: 'Confirmed', blockTime: tx.at / 1000, newOnChainState: tx.to, previousOnChainState: tx.from})),
      ActionHistory: log.filter((tx) => tx.kind === 'SubmitResult').map((tx) => ({submittedTxHash: tx.txId, resultHash: tx.resultHash})),
      RequestedFunds: funds,
      PaidFunds: record.purchased ? funds : [],
      WithdrawnForSeller: status.paidToSellerAtomic && status.paidToSellerAtomic !== '0' ? [{amount: status.paidToSellerAtomic, unit: record.unit}] : [],
      WithdrawnForBuyer: status.paidToBuyerAtomic && status.paidToBuyerAtomic !== '0' ? [{amount: status.paidToBuyerAtomic, unit: record.unit}] : [],
      PaymentSource: {network: 'Preprod', paymentSourceType: 'Web3CardanoV2', smartContractAddress: 'addr_test1_fake_v2_escrow'},
      SmartContractWallet: {walletVkey: 'fake-seller-vkey'},
    };
  }
}

function ok(data: {[key: string]: unknown}): Response {
  return respond(200, {status: 'success', data});
}

function respond(status: number, body: {[key: string]: unknown}): Response {
  return new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
}
