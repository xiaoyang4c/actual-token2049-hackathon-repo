import {createHash} from 'node:crypto';
import type {ScoreRequest} from '../../packages/core/src';

/** Local demo envelope. This is not a standard Cardano x402 payment rail. */
export interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  maxTimeoutSeconds: number;
  inputHash?: string;
}

export class PaymentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

export const scoreInputHash = (request: ScoreRequest): string => sha256(JSON.stringify({
  markets: request.markets.map(({venue, marketId, yesPrice}) => ({venue, marketId, yesPrice})),
}));

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PaymentError('expected an object');
  }
  return value as Record<string, unknown>;
}

export function textField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PaymentError(`${label} must be a nonempty string`);
  }
  return value;
}

export function lovelace(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) ||
      !Number.isSafeInteger(Number(value))) {
    throw new PaymentError('amount must be a positive safe integer in lovelace');
  }
  return Number(value);
}

export interface ApiTransport {
  /** Fixtures must set this flag so their receipts stay labelled simulated. */
  simulated: boolean;
  fetch: (url: string, init: RequestInit) => Promise<Response>;
}

export type CredentialResolver = (reference: string) => string | undefined;
