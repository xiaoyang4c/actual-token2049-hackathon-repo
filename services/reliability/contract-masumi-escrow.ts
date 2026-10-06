/**
 * @fileoverview Masumi payment service (MPS) V2 escrow for the contract
 * lifecycle.
 *
 * Endpoints and fields follow masumi-payment-service rev d569a33. Check
 * them against the node's /api-docs before a live run. The adapter uses
 * the shared PaymentApiClient, so the CARDANO_ALLOW_NETWORK gate, the
 * credential references, and the request timeout apply.
 *
 * Masumi V2 actions used here:
 * - create_terms: POST /payment (seller key). Signs the deadlines and amount.
 * - lock_funds: POST /purchase (buyer key).
 * - submit_result: POST /payment/submit-result (seller key).
 * - request_refund: POST /purchase/request-refund (buyer key).
 * - authorize_withdrawal: POST /purchase/cancel-refund-request (buyer key).
 *   On V2 this is AuthorizeWithdrawal and works from Disputed only.
 * - authorize_refund: POST /payment/authorize-refund (seller key).
 */

import type {PaymentConfig} from '../cardano-agents-ts/config';
import {PaymentApiClient} from '../cardano-agents-ts/http-client';
import {object, PaymentError, type ApiTransport, type CredentialResolver} from '../cardano-agents-ts/types';
import {
  EscrowRejectedError, EscrowRetryableError, type ContractEscrow, type EscrowRequest,
  type EscrowResult, type EscrowStatus, type ScalarRecord,
} from '../../packages/reliability/src/contract-lifecycle/ports';
import type {Deadlines, OnChainState} from '../../packages/reliability/src/contract-lifecycle/types';

export interface MasumiContractEscrowConfig {
  /** Registered Masumi agent that receives the escrow. At least 57 characters. */
  agentIdentifier: string;
  /** Index of the V2 payment source in the agent registration. */
  supportedPaymentSourceIndex: number;
  /**
   * `custodial_wallet` leaves the seller payout on the platform selling
   * wallet (the route the TOKEN2049 guide tested). `seller_return_address`
   * signs the seller's own address into the terms. That route is untested.
   */
  sellerPayout: 'custodial_wallet'|'seller_return_address';
}

const ON_CHAIN_STATES: readonly OnChainState[] = [
  'FundsLocked', 'FundsOrDatumInvalid', 'ResultSubmitted', 'RefundRequested', 'Disputed',
  'WithdrawAuthorized', 'RefundAuthorized', 'Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn',
];

/** MPS next actions that mean no transaction is in flight for that side. */
const IDLE_ACTIONS = new Set(['WaitingForExternalAction', 'None', 'Ignore']);

type Role = 'buyer'|'seller';

export class MasumiContractEscrow implements ContractEscrow {
  /** A fixture transport is not a chain, so its contracts stay labelled paper. */
  readonly mode: 'paper'|'live';
  private readonly client: PaymentApiClient;

  constructor(
    private readonly payment: PaymentConfig,
    private readonly config: MasumiContractEscrowConfig,
    transport?: ApiTransport,
    resolveCredential?: CredentialResolver,
  ) {
    if (payment.masumiPaymentSourceType !== 'Web3CardanoV2') {
      throw new Error('the contract lifecycle needs a Web3CardanoV2 payment source (MASUMI_PAYMENT_SOURCE_TYPE)');
    }
    if (config.agentIdentifier.length < 57) {
      throw new Error('a registered Masumi agent identifier (at least 57 characters) is required');
    }
    this.client = new PaymentApiClient(payment, payment.masumiUrl, transport, resolveCredential);
    this.mode = this.client.simulated ? 'paper' : 'live';
  }

  async execute(request: EscrowRequest): Promise<EscrowResult> {
    if (request.kind === 'create_terms') return this.createTerms(request);
    const terms = requireTerms(request);
    const blockchainIdentifier = text(terms.blockchainIdentifier, 'blockchainIdentifier');
    if (request.kind !== 'lock_funds') await this.assertIdle(blockchainIdentifier);
    const body = {network: 'Preprod', blockchainIdentifier};
    switch (request.kind) {
      case 'lock_funds':
        await this.post('/purchase', 'buyer', this.purchaseBody(request, terms), true);
        break;
      case 'submit_result':
        await this.post('/payment/submit-result', 'seller', {...body, submitResultHash: text(request.payload.resultHash, 'resultHash')});
        break;
      case 'request_refund':
        await this.post('/purchase/request-refund', 'buyer', body);
        break;
      case 'authorize_withdrawal':
        await this.post('/purchase/cancel-refund-request', 'buyer', body);
        break;
      case 'authorize_refund':
        await this.post('/payment/authorize-refund', 'seller', body);
        break;
      default:
        throw new EscrowRejectedError(`unknown operation ${String(request.kind)}`);
    }
    return {ref: blockchainIdentifier};
  }

  async inspect(request: EscrowRequest): Promise<EscrowResult&{status: 'applied'|'not_applied'|'unknown'}> {
    // Unused payment terms lock no funds, so creating terms again is safe.
    if (request.kind === 'create_terms') return {status: 'not_applied'};
    const terms = requireTerms(request);
    const blockchainIdentifier = text(terms.blockchainIdentifier, 'blockchainIdentifier');
    try {
      if (request.kind === 'lock_funds') {
        const purchase = await this.resolve('buyer', blockchainIdentifier);
        return purchase ? {status: 'applied', ref: blockchainIdentifier} : {status: 'not_applied'};
      }
      const role: Role = request.kind === 'submit_result' || request.kind === 'authorize_refund' ? 'seller' : 'buyer';
      const view = await this.resolve(role, blockchainIdentifier);
      if (!view) return {status: 'unknown'};
      const state = optionalText(view.onChainState);
      const next = object(view.NextAction);
      const action = optionalText(next.requestedAction) ?? '';
      const applied = (states: string[], actions: string[]) =>
        states.includes(state ?? '') || actions.includes(action);
      let done = false;
      if (request.kind === 'submit_result') {
        const hash = String(request.payload.resultHash);
        done = view.resultHash === hash || (next.resultHash === hash && action.startsWith('SubmitResult'));
      } else if (request.kind === 'request_refund') {
        done = applied(['RefundRequested', 'Disputed', 'RefundAuthorized', 'RefundWithdrawn', 'DisputedWithdrawn'],
          ['SetRefundRequestedRequested', 'SetRefundRequestedInitiated']);
      } else if (request.kind === 'authorize_withdrawal') {
        done = applied(['WithdrawAuthorized', 'Withdrawn'], ['AuthorizeWithdrawalRequested', 'AuthorizeWithdrawalInitiated']);
      } else if (request.kind === 'authorize_refund') {
        done = applied(['RefundAuthorized', 'RefundWithdrawn'], ['AuthorizeRefundRequested', 'AuthorizeRefundInitiated']);
      }
      return done ? {status: 'applied', ref: blockchainIdentifier} : {status: 'not_applied'};
    } catch {
      return {status: 'unknown'};
    }
  }

  async status(ref: string, terms: ScalarRecord|null): Promise<EscrowStatus> {
    const unit = text(terms?.unit, 'unit');
    const amount = text(terms?.amountAtomic, 'amountAtomic');
    const [payment, purchase] = await Promise.all([this.resolve('seller', ref), this.resolve('buyer', ref)]);
    const view = payment ?? purchase;
    if (!view) throw new EscrowRetryableError(`the payment service has no record of ${ref} yet`);
    const state = parseState(view.onChainState);
    const idle = [payment, purchase].every((side) => {
      if (!side) return true;
      const action = optionalText(object(side.NextAction).requestedAction) ?? 'None';
      const current = side.CurrentTransaction ? object(side.CurrentTransaction) : null;
      return IDLE_ACTIONS.has(action) && (!current || current.status === 'Confirmed');
    });
    const transactions = [view.CurrentTransaction, ...(Array.isArray(view.TransactionHistory) ? view.TransactionHistory : [])]
      .filter((entry) => entry !== null && entry !== undefined).map(object);
    const payout = transactions.find((tx) => tx.status === 'Confirmed' &&
      ['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn'].includes(String(tx.newOnChainState)));
    const current = view.CurrentTransaction ? object(view.CurrentTransaction) : null;
    const paid = (value: unknown): string|null => sumUnit(value, unit);
    let toSeller = paid(payment?.WithdrawnForSeller ?? purchase?.WithdrawnForSeller);
    let toBuyer = paid(payment?.WithdrawnForBuyer ?? purchase?.WithdrawnForBuyer);
    // The cooperative paths pay the whole escrow value. Only an admin split needs the reported amounts.
    if (state === 'Withdrawn') {
      toSeller ??= amount;
      toBuyer ??= '0';
    }
    if (state === 'RefundWithdrawn') {
      toBuyer ??= amount;
      toSeller ??= '0';
    }
    return {
      onChainState: state,
      confirmed: idle,
      lastTxHash: optionalText(current?.txHash) ?? null,
      resultHash: optionalText(view.resultHash) ?? null,
      paidToSellerAtomic: toSeller,
      paidToBuyerAtomic: toBuyer,
      settlementTxHash: optionalText(payout?.txHash) ?? null,
    };
  }

  private async createTerms(request: EscrowRequest): Promise<EscrowResult> {
    const payload = request.payload;
    const deadlines = payload.deadlines as Deadlines;
    const amountAtomic = text(payload.amountAtomic, 'amountAtomic');
    const unit = text(payload.assetUnit, 'assetUnit');
    const sellerReturnAddress = this.config.sellerPayout === 'seller_return_address' ?
      text(payload.sellerAddress, 'sellerAddress') : undefined;
    const data = await this.post('/payment', 'seller', {
      network: 'Preprod',
      agentIdentifier: this.config.agentIdentifier,
      inputHash: text(payload.inputHash, 'inputHash'),
      identifierFromPurchaser: text(payload.identifierFromPurchaser, 'identifierFromPurchaser'),
      paymentSourceType: 'Web3CardanoV2',
      supportedPaymentSourceIndex: this.config.supportedPaymentSourceIndex,
      RequestedFunds: [{amount: amountAtomic, unit}],
      payByTime: new Date(deadlines.payByTime).toISOString(),
      submitResultTime: new Date(deadlines.submitResultTime).toISOString(),
      unlockTime: new Date(deadlines.unlockTime).toISOString(),
      externalDisputeUnlockTime: new Date(deadlines.externalDisputeUnlockTime).toISOString(),
      metadata: typeof payload.metadata === 'string' ? payload.metadata : undefined,
      ...(sellerReturnAddress ? {sellerReturnAddress} : {}),
    }, true);
    const source = object(data.PaymentSource);
    const wallet = object(data.SmartContractWallet);
    const smartContractAddress = text(source.smartContractAddress, 'smartContractAddress');
    const mismatch = source.network !== 'Preprod' || source.paymentSourceType !== 'Web3CardanoV2' ||
      data.agentIdentifier !== this.config.agentIdentifier || data.inputHash !== payload.inputHash ||
      sumUnit(data.RequestedFunds, unit) !== amountAtomic || !smartContractAddress.startsWith('addr_test1');
    if (mismatch) throw new EscrowRejectedError('the payment service returned terms that do not match the request');
    for (const name of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const) {
      if (String(data[name]) !== String(deadlines[name])) {
        throw new EscrowRejectedError(`the payment service returned a different ${name}`);
      }
    }
    const blockchainIdentifier = text(data.blockchainIdentifier, 'blockchainIdentifier');
    return {
      ref: blockchainIdentifier,
      terms: {
        blockchainIdentifier,
        agentIdentifier: this.config.agentIdentifier,
        supportedPaymentSourceIndex: this.config.supportedPaymentSourceIndex,
        smartContractAddress,
        sellerVkey: text(wallet.walletVkey, 'walletVkey'),
        inputHash: text(payload.inputHash, 'inputHash'),
        identifierFromPurchaser: text(payload.identifierFromPurchaser, 'identifierFromPurchaser'),
        amountAtomic,
        unit,
        payByTime: String(deadlines.payByTime),
        submitResultTime: String(deadlines.submitResultTime),
        unlockTime: String(deadlines.unlockTime),
        externalDisputeUnlockTime: String(deadlines.externalDisputeUnlockTime),
        // A non-null seller layer override is part of the signed terms; copy it back unchanged.
        paymentForceLayer: optionalText(data.forceLayer) ?? null,
        sellerReturnAddress: optionalText(data.sellerReturnAddress) ?? null,
        mode: this.mode,
      },
    };
  }

  private purchaseBody(request: EscrowRequest, terms: ScalarRecord): {[key: string]: unknown} {
    return {
      network: 'Preprod',
      blockchainIdentifier: text(terms.blockchainIdentifier, 'blockchainIdentifier'),
      paymentSourceType: 'Web3CardanoV2',
      smartContractAddress: text(terms.smartContractAddress, 'smartContractAddress'),
      supportedPaymentSourceIndex: Number(terms.supportedPaymentSourceIndex),
      inputHash: text(terms.inputHash, 'inputHash'),
      sellerVkey: text(terms.sellerVkey, 'sellerVkey'),
      agentIdentifier: text(terms.agentIdentifier, 'agentIdentifier'),
      Amounts: [{amount: text(terms.amountAtomic, 'amountAtomic'), unit: text(terms.unit, 'unit')}],
      payByTime: text(terms.payByTime, 'payByTime'),
      submitResultTime: text(terms.submitResultTime, 'submitResultTime'),
      unlockTime: text(terms.unlockTime, 'unlockTime'),
      externalDisputeUnlockTime: text(terms.externalDisputeUnlockTime, 'externalDisputeUnlockTime'),
      identifierFromPurchaser: text(terms.identifierFromPurchaser, 'identifierFromPurchaser'),
      ...(typeof terms.paymentForceLayer === 'string' ? {paymentForceLayer: terms.paymentForceLayer} : {}),
      ...(typeof terms.sellerReturnAddress === 'string' ? {sellerReturnAddress: terms.sellerReturnAddress} : {}),
      metadata: `request ${request.idempotencyKey}`,
    };
  }

  /** A write while the other side has a transaction in flight would fail or race. Retry later. */
  private async assertIdle(blockchainIdentifier: string): Promise<void> {
    const [payment, purchase] = await Promise.all([
      this.resolve('seller', blockchainIdentifier), this.resolve('buyer', blockchainIdentifier),
    ]);
    for (const side of [payment, purchase]) {
      if (!side) continue;
      const next = object(side.NextAction);
      if (next.errorType) {
        throw new EscrowRejectedError(`the payment service needs manual recovery: ${String(next.errorNote ?? next.errorType)}`);
      }
      const action = optionalText(next.requestedAction) ?? 'None';
      if (!IDLE_ACTIONS.has(action)) throw new EscrowRetryableError(`the escrow has ${action} in flight`);
    }
  }

  private async resolve(role: Role, blockchainIdentifier: string): Promise<{[key: string]: unknown}|null> {
    const path = role === 'buyer' ? '/purchase/resolve-blockchain-identifier' : '/payment/resolve-blockchain-identifier';
    try {
      return await this.post(path, role, {network: 'Preprod', blockchainIdentifier, includeHistory: 'true'});
    } catch (error) {
      // A 404 means this side has no record. It does not prove that no funds are locked.
      if (error instanceof EscrowRejectedError && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  private async post(path: string, role: Role, body: unknown, acceptExisting = false): Promise<{[key: string]: unknown}> {
    let response: Response;
    try {
      response = await this.client.request(path,
        role === 'buyer' ? this.payment.masumiBuyerKeyRef : this.payment.masumiSellerKeyRef, 'token', {
          method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
        });
    } catch (error) {
      // Network errors, timeouts, a closed network gate, and a missing credential all stay
      // retryable: an operator can fix the cause, and the journaled operation then continues.
      throw new EscrowRetryableError(error instanceof PaymentError ? error.message : 'payment service request failed');
    }
    // MPS returns the existing record under `object` for a duplicate create.
    if (response.status === 409 && acceptExisting) return object(object(await response.json()).object);
    if (response.status >= 500 || response.status === 429) {
      throw new EscrowRetryableError(`Masumi ${path} failed (${response.status})`);
    }
    if (!response.ok) throw new EscrowRejectedError(`Masumi ${path} failed (${response.status})`);
    const envelope = object(await response.json());
    if (typeof envelope.status !== 'string' || envelope.status.toLowerCase() !== 'success') {
      throw new EscrowRetryableError(`Masumi ${path} returned an invalid envelope`);
    }
    return object(envelope.data);
  }
}

function requireTerms(request: EscrowRequest): ScalarRecord {
  if (!request.terms) throw new EscrowRejectedError(`${request.kind} needs the signed escrow terms`);
  return request.terms;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') throw new EscrowRejectedError(`${label} is missing`);
  return value;
}

function optionalText(value: unknown): string|undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function parseState(value: unknown): OnChainState|null {
  if (value === null || value === undefined) return null;
  const state = ON_CHAIN_STATES.find((item) => item === value);
  if (!state) throw new EscrowRetryableError(`unknown on-chain state ${String(value)}`);
  return state;
}

/** Sums the amounts of one asset unit. Returns null when the field is absent. */
function sumUnit(value: unknown, unit: string): string|null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new EscrowRetryableError('the payment service returned malformed funds');
  if (value.length === 0) return null;
  let total = 0n;
  for (const entry of value) {
    const fund = object(entry);
    if (fund.unit !== unit) continue;
    if (typeof fund.amount !== 'string' || !/^[0-9]+$/.test(fund.amount)) {
      throw new EscrowRetryableError('the payment service returned a malformed amount');
    }
    total += BigInt(fund.amount);
  }
  return total.toString();
}
