/**
 * @fileoverview Parses lifecycle HTTP values and dispatches demo actions.
 * This adapter has no direct store access.
 */

import {
  LifecycleError, type EscrowTransactionLifecycle, type LifecycleTransition,
} from '../../packages/reliability/src/lifecycle';
import type {JsonValue, TransactionType} from '../../packages/reliability/src/types';

function isRecord(value: unknown): value is {[key: string]: unknown} {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textField(body: {[key: string]: unknown}, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new LifecycleError(`${key} must be a non-empty string`);
  }
  return value;
}

export function optionalText(
  body: {[key: string]: unknown}, key: string,
): string|undefined {
  if (body[key] === undefined) return undefined;
  return textField(body, key);
}

export function termsField(value: unknown): {[key: string]: JsonValue} {
  const parsed = jsonValue(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('terms must be an object');
  }
  return parsed;
}

function jsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new LifecycleError('terms must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (isRecord(value)) {
    const record: {[key: string]: JsonValue} = {};
    for (const [key, item] of Object.entries(value)) record[key] = jsonValue(item);
    return record;
  }
  throw new LifecycleError('terms must be JSON values');
}

function evidenceField(
  value: unknown,
): LifecycleTransition['evidence'] {
  if (!isRecord(value)) throw new LifecycleError('evidence must be an object');
  const evidence: LifecycleTransition['evidence'] = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') {
      evidence[key] = item;
      continue;
    }
    if (typeof item === 'number' && Number.isFinite(item)) {
      evidence[key] = item;
      continue;
    }
    throw new LifecycleError('evidence values must be scalars');
  }
  return evidence;
}

export function transactionType(value: string): TransactionType {
  if (value === 'goods' || value === 'service' || value === 'invoice') return value;
  throw new LifecycleError('unknown transaction type');
}

export async function readBody(request: Request): Promise<{[key: string]: unknown}> {
  try {
    const value: unknown = await request.json();
    if (!isRecord(value)) throw new LifecycleError('body must be an object');
    return value;
  } catch (error) {
    if (error instanceof LifecycleError) throw error;
    throw new LifecycleError('body must be JSON');
  }
}

export async function runAction(
  lifecycle: EscrowTransactionLifecycle,
  action: string,
  transactionId: string,
  at: string,
  body: {[key: string]: unknown},
): Promise<LifecycleTransition> {
  if (action === 'fund') {
    const amount = body.amountLovelace;
    if (typeof amount !== 'number') {
      throw new LifecycleError('amountLovelace must be a positive integer');
    }
    return lifecycle.fund({
      transactionId,
      amountLovelace: amount,
      sellerReturnAddress: textField(body, 'sellerReturnAddress'),
      disputeWindowEnds: textField(body, 'disputeWindowEnds'),
      at,
    });
  }
  if (action === 'deliver') {
    return lifecycle.confirmDelivery({
      transactionId,
      at,
      evidence: evidenceField(body.evidence),
    });
  }
  if (action === 'release') {
    return lifecycle.release({
      transactionId,
      at,
      evidence: body.evidence === undefined ? undefined : evidenceField(body.evidence),
    });
  }
  if (action === 'refund') {
    return lifecycle.refund({
      transactionId,
      at,
      reason: optionalText(body, 'reason'),
    });
  }
  if (action === 'cancel') {
    return lifecycle.cancel({
      transactionId, at, reason: textField(body, 'reason'),
    });
  }
  if (action === 'terminate') {
    return lifecycle.mutualTerminate({
      transactionId,
      at,
      buyerConsentAt: textField(body, 'buyerConsentAt'),
      sellerConsentAt: textField(body, 'sellerConsentAt'),
    });
  }
  if (action === 'dispute') {
    return lifecycle.openDispute({
      transactionId,
      at,
      resolver: textField(body, 'resolver'),
      resolveBy: textField(body, 'resolveBy'),
      reason: optionalText(body, 'reason'),
    });
  }
  if (action === 'resolve') {
    const decision = textField(body, 'decision');
    if (decision !== 'uphold_seller' && decision !== 'uphold_buyer') {
      throw new LifecycleError(
        'a dispute resolution must uphold the seller or the buyer',
      );
    }
    return lifecycle.resolveDispute({
      transactionId,
      at,
      resolver: textField(body, 'resolver'),
      decision,
    });
  }
  throw new LifecycleError('unknown lifecycle action');
}
