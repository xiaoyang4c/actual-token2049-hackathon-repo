/**
 * @fileoverview The seller side of the Masumi payment service (MPS) for
 * Coworker Tasks. The Coworker asks for payment, Sokosumi locks the buyer's
 * funds in the Masumi V2 escrow, the Coworker submits its result hash, and
 * MPS collects after the unlock time.
 *
 * Routes (MPS rev d569a33): POST /payment, /payment/resolve-blockchain-identifier,
 * /payment/submit-result. Field names are the MPS wire names.
 */

import {isIdentifierFromPurchaser, mip004InputHash, sha256Hex} from '../../packages/reliability/src/contract-lifecycle/hashing';
import {TEST_USDM_UNIT} from './contract-config';

const MINUTE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Deadlines from the moment the Coworker asks for payment. They satisfy the
 * MPS rules (payBy at least 5 min before submitResult; 15 min or more between
 * submitResult, unlock, and the external dispute unlock) with one minute of
 * margin each. Masumi's reference Coworker completed preprod Tasks with them.
 */
export const TASK_PAYMENT_WINDOWS = {
  payByAfterMs: 15 * MINUTE_MS,
  submitResultAfterMs: 20 * MINUTE_MS,
  unlockAfterMs: 36 * MINUTE_MS,
  externalDisputeAfterMs: 52 * MINUTE_MS,
} as const;

/** The registered agent and the selling wallet that receive the payment. */
export interface SellerSource {
  agentIdentifier: string;
  policyId: string;
  smartContractAddress: string;
  sellerVkey: string;
  sellerAddress: string;
  supportedPaymentSourceIndex: number;
}

export interface PaymentPlan {
  taskId: string;
  input: {taskId: string; name: string; description: string|null};
  identifierFromPurchaser: string;
  inputHash: string;
  amountAtomic: string;
  payByTime: string;
  submitResultTime: string;
  unlockTime: string;
  externalDisputeUnlockTime: string;
}

export interface MpsPayment {
  id: string;
  blockchainIdentifier: string;
  agentIdentifier: string;
  inputHash: string;
  onChainState: string|null;
  resultHash: string|null;
  nextActionResultHash: string|null;
  requestedAction: string|null;
  errorType: string|null;
  txHash: string|null;
  txStatus: string|null;
  confirmations: number;
  times: {payByTime: string; submitResultTime: string; unlockTime: string; externalDisputeUnlockTime: string};
  funds: Array<{unit: string; amount: string}>;
  wallet: {walletVkey: string; walletAddress: string};
  source: {network: string; paymentSourceType: string; policyId: string; smartContractAddress: string};
}

/**
 * One plan per Task. The nonce comes from the Task id and the agent, so a
 * repeated plan for the same Task has the same input hash.
 */
export function paymentPlan(
  task: {id: string; name: string; description: string|null}, source: SellerSource, amountAtomic: string, nowMs: number,
): PaymentPlan {
  if (!/^[1-9][0-9]*$/.test(amountAtomic)) throw new Error('amountAtomic must be a positive integer string');
  const input = {taskId: task.id, name: task.name, description: task.description};
  const identifierFromPurchaser = sha256Hex(JSON.stringify({taskId: task.id, agentIdentifier: source.agentIdentifier, network: 'Preprod'})).slice(0, 20);
  const at = (offset: number) => new Date(nowMs + offset).toISOString();
  return {
    taskId: task.id,
    input,
    identifierFromPurchaser,
    inputHash: mip004InputHash(identifierFromPurchaser, input),
    amountAtomic,
    payByTime: at(TASK_PAYMENT_WINDOWS.payByAfterMs),
    submitResultTime: at(TASK_PAYMENT_WINDOWS.submitResultAfterMs),
    unlockTime: at(TASK_PAYMENT_WINDOWS.unlockAfterMs),
    externalDisputeUnlockTime: at(TASK_PAYMENT_WINDOWS.externalDisputeAfterMs),
  };
}

/**
 * The result hash that Sokosumi Core checks: SHA-256 of the nonce, ";", and
 * the result as a JSON string body (quotes, backslashes, and newlines
 * escaped). It differs from a plain MIP-004 result hash for those characters.
 */
export function sokosumiResultHash(identifierFromPurchaser: string, result: string): string {
  if (!isIdentifierFromPurchaser(identifierFromPurchaser)) throw new Error('invalid identifierFromPurchaser');
  if (!result || !result.isWellFormed()) throw new Error('the result must be non-empty, well-formed text');
  return sha256Hex(`${identifierFromPurchaser};${JSON.stringify(result).slice(1, -1)}`);
}

/** The Task event that asks Sokosumi to pay this payment request. */
export function masumiPaymentEvent(source: SellerSource, plan: PaymentPlan, payment: MpsPayment): {[key: string]: unknown} {
  return {
    masumiPayment: {
      blockchainIdentifier: payment.blockchainIdentifier,
      identifierFromPurchaser: plan.identifierFromPurchaser,
      agentIdentifier: payment.agentIdentifier,
      sellerVkey: payment.wallet.walletVkey,
      inputHash: payment.inputHash,
      payByTime: payment.times.payByTime,
      submitResultTime: payment.times.submitResultTime,
      unlockTime: payment.times.unlockTime,
      externalDisputeUnlockTime: payment.times.externalDisputeUnlockTime,
      Amounts: payment.funds,
      paymentSourceType: payment.source.paymentSourceType,
      supportedPaymentSourceIndex: source.supportedPaymentSourceIndex,
      PaymentSource: {network: payment.source.network, policyId: payment.source.policyId, smartContractAddress: payment.source.smartContractAddress},
    },
  };
}

type Json = {[key: string]: unknown};
const record = (value: unknown): Json|null =>
  (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : null);
const str = (value: unknown): string|null => (typeof value === 'string' ? value : null);

function toPayment(value: unknown): MpsPayment {
  const item = record(value);
  const next = record(item?.NextAction);
  const tx = record(item?.CurrentTransaction);
  const wallet = record(item?.SmartContractWallet);
  const source = record(item?.PaymentSource);
  if (!item || typeof item.id !== 'string' || typeof item.blockchainIdentifier !== 'string' || !wallet || !source) {
    throw new Error('MPS returned a malformed payment');
  }
  const funds = Array.isArray(item.RequestedFunds) ?
    item.RequestedFunds.map(record).filter((fund): fund is Json => fund !== null).map((fund) => ({unit: str(fund.unit) ?? '', amount: str(fund.amount) ?? ''})) :
    [];
  return {
    id: item.id,
    blockchainIdentifier: item.blockchainIdentifier,
    agentIdentifier: str(item.agentIdentifier) ?? '',
    inputHash: str(item.inputHash) ?? '',
    onChainState: str(item.onChainState),
    resultHash: str(item.resultHash) || null,
    nextActionResultHash: str(next?.resultHash) || null,
    requestedAction: str(next?.requestedAction),
    errorType: str(next?.errorType),
    txHash: str(tx?.txHash),
    txStatus: str(tx?.status),
    confirmations: typeof tx?.confirmations === 'number' ? tx.confirmations : 0,
    times: {
      payByTime: String(item.payByTime ?? ''),
      submitResultTime: String(item.submitResultTime ?? ''),
      unlockTime: String(item.unlockTime ?? ''),
      externalDisputeUnlockTime: String(item.externalDisputeUnlockTime ?? ''),
    },
    funds,
    wallet: {walletVkey: str(wallet.walletVkey) ?? '', walletAddress: str(wallet.walletAddress) ?? ''},
    source: {
      network: str(source.network) ?? '', paymentSourceType: str(source.paymentSourceType) ?? '',
      policyId: str(source.policyId) ?? '', smartContractAddress: str(source.smartContractAddress) ?? '',
    },
  };
}

/** Throws if MPS returned a payment that is not the one we asked for. */
export function checkPayment(payment: MpsPayment, plan: PaymentPlan, source: SellerSource): void {
  const problems: string[] = [];
  if (payment.agentIdentifier !== source.agentIdentifier) problems.push('agent');
  if (payment.inputHash !== plan.inputHash) problems.push('input hash');
  if (payment.funds.length !== 1 || payment.funds[0]?.unit !== TEST_USDM_UNIT || payment.funds[0]?.amount !== plan.amountAtomic) problems.push('funds');
  if (payment.wallet.walletVkey !== source.sellerVkey || payment.wallet.walletAddress !== source.sellerAddress) problems.push('seller wallet');
  if (payment.source.smartContractAddress !== source.smartContractAddress || payment.source.policyId !== source.policyId) problems.push('payment source');
  for (const key of ['payByTime', 'submitResultTime', 'unlockTime', 'externalDisputeUnlockTime'] as const) {
    if (payment.times[key] !== String(Date.parse(plan[key]))) problems.push(key);
  }
  if (payment.errorType) problems.push(`MPS error ${payment.errorType}`);
  if (problems.length) throw new Error(`MPS payment does not match the request: ${problems.join(', ')}`);
}

/** True when the escrow holds the buyer's funds in a confirmed transaction. */
export function fundsLocked(payment: MpsPayment): boolean {
  return payment.onChainState === 'FundsLocked' && payment.txStatus === 'Confirmed' && Boolean(payment.txHash) && payment.confirmations > 0;
}

/** True when MPS withdrew the funds to the seller in a confirmed transaction. */
export function collected(payment: MpsPayment): boolean {
  return payment.onChainState === 'Withdrawn' && payment.txStatus === 'Confirmed' && Boolean(payment.txHash) && payment.confirmations > 0;
}

/** `uncertain` means the request may have reached MPS. Read the payment before a retry. */
export class MpsError extends Error {
  constructor(message: string, readonly uncertain: boolean) {
    super(message);
    this.name = 'MpsError';
  }
}

export class MpsSeller {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly token: string, options: {baseUrl?: string; fetch?: typeof fetch} = {}) {
    if (!token.trim() || /[\r\n]/.test(token)) throw new Error('missing or invalid MPS token');
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:3001/api/v1').replace(/\/+$/, '');
    const host = new URL(this.baseUrl);
    if (!(host.protocol === 'https:' || (host.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)))) {
      throw new Error('the MPS URL must use HTTPS or local loopback HTTP');
    }
    this.fetcher = options.fetch ?? fetch;
  }

  private async post(path: string, body: Json): Promise<MpsPayment> {
    const writes = path !== 'payment/resolve-blockchain-identifier';
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/${path}`, {
        method: 'POST', redirect: 'error',
        headers: {'token': this.token, 'content-type': 'application/json'},
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new MpsError(`MPS ${path} got no response`, writes);
    }
    if (!response.ok) throw new MpsError(`MPS ${path} returned ${response.status}`, writes && (response.status === 408 || response.status >= 500));
    const envelope = record(await response.json().catch(() => null));
    try {
      return toPayment(envelope?.data);
    } catch {
      throw new MpsError(`MPS ${path} returned a malformed payment`, writes);
    }
  }

  async createPayment(plan: PaymentPlan, source: SellerSource): Promise<MpsPayment> {
    const payment = await this.post('payment', {
      network: 'Preprod',
      paymentSourceType: 'Web3CardanoV2',
      agentIdentifier: source.agentIdentifier,
      supportedPaymentSourceIndex: source.supportedPaymentSourceIndex,
      inputHash: plan.inputHash,
      identifierFromPurchaser: plan.identifierFromPurchaser,
      RequestedFunds: [{unit: TEST_USDM_UNIT, amount: plan.amountAtomic}],
      payByTime: plan.payByTime,
      submitResultTime: plan.submitResultTime,
      unlockTime: plan.unlockTime,
      externalDisputeUnlockTime: plan.externalDisputeUnlockTime,
    });
    try {
      checkPayment(payment, plan, source);
    } catch {
      throw new MpsError('MPS created a payment that does not match the request', true);
    }
    return payment;
  }

  async read(blockchainIdentifier: string, source: SellerSource): Promise<MpsPayment> {
    return this.post('payment/resolve-blockchain-identifier', {
      network: 'Preprod', blockchainIdentifier, filterSmartContractAddress: source.smartContractAddress,
    });
  }

  async submitResult(blockchainIdentifier: string, resultHash: string): Promise<MpsPayment> {
    return this.post('payment/submit-result', {network: 'Preprod', blockchainIdentifier, submitResultHash: resultHash});
  }
}
