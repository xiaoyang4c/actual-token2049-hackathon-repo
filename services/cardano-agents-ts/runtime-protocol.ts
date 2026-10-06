import type {PaymentReceiptRecord} from '../../packages/db/src';
import type {PaymentConfig} from './config';
import type {MasumiPaymentRequest, MasumiTerms} from './masumi';
import {lovelace, object, PaymentError, sha256, textField, type PaymentRequirement} from './types';

export interface PaymentSession {
  mode: PaymentConfig['mode'];
  configurationHash: string;
  fingerprint: string;
  bindInput: boolean;
  request: MasumiPaymentRequest;
  terms?: MasumiTerms;
  /** Saved before the purchase call, including calls whose response was lost. */
  purchaseAttempted?: boolean;
  purchaseRequested?: boolean;
  resultQueued?: boolean;
  confirmations?: number;
}

export interface VerifyRequest {
  xPayment: string;
  resource: string;
  amount: number;
  payTo: string;
  inputHash?: string;
}

export function encodePaymentHeader(receipt: PaymentReceiptRecord): string {
  return Buffer.from(JSON.stringify({
    x402Version: 1, scheme: 'exact', network: receipt.network,
    payload: {receiptId: receipt.receiptId, txHash: receipt.txHash},
  })).toString('base64');
}

export function paymentRequirement(value: unknown, config: PaymentConfig): PaymentRequirement {
  const raw = object(value);
  const amount = lovelace(raw.maxAmountRequired);
  if (amount > config.maxPaymentLovelace) throw new PaymentError('amount exceeds the per-payment cap', 403);
  if (raw.scheme !== 'exact' || raw.network !== config.network || raw.asset !== 'lovelace') {
    throw new PaymentError('unsupported payment scheme, network, or asset');
  }
  if (raw.payTo !== config.scorePayTo) throw new PaymentError('payment payee is not configured');
  const timeout = raw.maxTimeoutSeconds;
  if (typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 3600) {
    throw new PaymentError('payment timeout must be in [1, 3600] seconds');
  }
  if (raw.inputHash !== undefined && (typeof raw.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.inputHash))) {
    throw new PaymentError('inputHash must be a SHA256 hex digest');
  }
  if (config.mode === 'preprod' && !raw.inputHash) throw new PaymentError('preprod requires a score input hash');
  return {
    scheme: 'exact', network: config.network, maxAmountRequired: String(amount), asset: 'lovelace',
    payTo: config.scorePayTo, resource: textField(raw.resource, 'resource'),
    description: typeof raw.description === 'string' ? raw.description : '', maxTimeoutSeconds: timeout,
    ...(raw.inputHash ? {inputHash: raw.inputHash as string} : {}),
  };
}

export function createPaymentRequest(
  key: string, requirement: PaymentRequirement, config: PaymentConfig, createdAt: string,
): MasumiPaymentRequest {
  const at = (seconds: number) => new Date(Date.parse(createdAt) + seconds * 1000).toISOString();
  return {
    network: 'Preprod', inputHash: requirement.inputHash ?? sha256(requirement.resource),
    agentIdentifier: config.masumiAgentIdentifier, identifierFromPurchaser: sha256(key).slice(0, 20),
    paymentSourceType: config.masumiPaymentSourceType,
    ...(config.masumiPaymentSourceType === 'Web3CardanoV2'
      ? {supportedPaymentSourceIndex: config.masumiSupportedSourceIndex} : {}),
    payByTime: at(requirement.maxTimeoutSeconds), submitResultTime: at(requirement.maxTimeoutSeconds + 300),
    unlockTime: at(requirement.maxTimeoutSeconds + 900), externalDisputeUnlockTime: at(requirement.maxTimeoutSeconds + 1800),
    sellerReturnAddress: requirement.payTo, forceLayer: 'L1',
  };
}

export function session(receipt: PaymentReceiptRecord): PaymentSession {
  if (!receipt.protocolData) throw new PaymentError('legacy receipt requires reconciliation', 409);
  return JSON.parse(receipt.protocolData) as PaymentSession;
}

export function verifyRequest(value: unknown): VerifyRequest {
  const body = object(value);
  if (typeof body.amount !== 'number' || !Number.isSafeInteger(body.amount) || body.amount <= 0) {
    throw new PaymentError('verification amount must be a positive integer');
  }
  return {
    xPayment: textField(body.xPayment, 'xPayment'), resource: textField(body.resource, 'resource'),
    amount: body.amount, payTo: textField(body.payTo, 'payTo'),
    inputHash: typeof body.inputHash === 'string' ? body.inputHash : undefined,
  };
}
