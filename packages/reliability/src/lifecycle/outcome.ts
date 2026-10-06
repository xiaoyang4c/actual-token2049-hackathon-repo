/**
 * @fileoverview Derives outcomes from lifecycle history without store writes.
 * The state machine owns persistence. This module owns fault and evidence.
 */

import type {JsonValue, Outcome} from '../types';
import {parseTime, readTier} from './codecs';
import {
  DELIVERY_TIER_VERIFICATION, LifecycleError, RESOLVER_CONFIDENCE,
  VOLUNTARY_REFUND_CONFIDENCE,
  type LifecycleStage, type LifecycleTransition,
} from './contracts';

const CANCEL_CONFIDENCE = 1;
const TIMEOUT_CONFIDENCE = 1;

/** Projects the last stage and its verification evidence into an outcome. */
export function projectLifecycleOutcome(
  transactionId: string,
  history: readonly LifecycleTransition[],
  options: {resolver?: string; resolveBy?: string; now: string},
  version: string,
): Outcome {
  parseTime(options.now, 'now');
  const latest = history[history.length - 1];
  const stage = latest?.to;
  const evidence: {[key: string]: JsonValue} = {
    ...(latest ? {...latest.evidence} : {}),
    stage: stage ?? 'none',
    transitions: history.length,
    producer: version,
  };
  return buildOutcome(transactionId, history, stage, evidence, options);
}

function buildOutcome(
  transactionId: string,
  history: readonly LifecycleTransition[],
  stage: LifecycleStage|undefined,
  evidence: {[key: string]: JsonValue},
  options: {resolver?: string; resolveBy?: string; now: string},
): Outcome {
  const base = {
    transactionId,
    evidence,
    decidedAt: options.now,
  };
  if (stage === 'payment_settled') {
    return settledOutcome(history, base);
  }
  if (stage === 'refunded') return refundedOutcome(history, base);
  if (stage === 'cancelled') {
    return {
      ...base,
      state: 'cancelled',
      ...(evidence.termination === 'mutual' ? {fault: 'none' as const} : {}),
      verificationMethod: 'lifecycle',
      verificationConfidence: CANCEL_CONFIDENCE,
    };
  }
  if (stage === 'dispute_opened') {
    return disputedOutcome(history, base, options);
  }
  if (stage === 'delivery_confirmed') {
    const tier = readTier(evidence.deliveryTier, true);
    const verification = DELIVERY_TIER_VERIFICATION[tier];
    return {
      ...base,
      state: 'pending',
      verificationMethod: verification.method,
      verificationConfidence: verification.confidence,
    };
  }
  return {...base, state: 'pending', verificationMethod: 'lifecycle'};
}

function settledOutcome(
  history: readonly LifecycleTransition[],
  base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
): Outcome {
  const settlement = findStage(history, 'payment_settled');
  if (settlement?.evidence.resolution === 'uphold_seller') {
    return {
      ...base,
      state: 'successful',
      verificationMethod: 'manual-review',
      verificationConfidence: RESOLVER_CONFIDENCE,
    };
  }
  const tierValue = settlement?.evidence.deliveryTier;
  const tier = readTier(tierValue, true);
  if (tier === 'self_report') {
    throw new LifecycleError('a self-reported delivery cannot settle');
  }
  const verification = DELIVERY_TIER_VERIFICATION[tier];
  return {
    ...base,
    state: 'successful',
    verificationMethod: verification.method,
    verificationConfidence: verification.confidence,
  };
}

function refundedOutcome(
  history: readonly LifecycleTransition[],
  base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
): Outcome {
  const refunded = findStage(history, 'refunded');
  const fault = refunded?.evidence.fault;
  if (fault === 'seller' || fault === 'buyer') {
    return {
      ...base,
      state: 'failed',
      fault,
      verificationMethod: fault === 'seller' ? 'manual-review' : 'lifecycle',
      verificationConfidence: fault === 'seller' ?
        RESOLVER_CONFIDENCE : VOLUNTARY_REFUND_CONFIDENCE,
    };
  }
  if (fault === 'none') {
    return {
      ...base,
      state: 'cancelled',
      fault: 'none',
      verificationMethod: 'lifecycle',
      verificationConfidence: VOLUNTARY_REFUND_CONFIDENCE,
    };
  }
  throw new LifecycleError('refund evidence is missing a fault');
}

function disputedOutcome(
  history: readonly LifecycleTransition[],
  base: {transactionId: string; evidence: {[key: string]: JsonValue}; decidedAt: string},
  options: {resolver?: string; resolveBy?: string; now: string},
): Outcome {
  const dispute = disputeRecord(history);
  if (options.resolver !== undefined && options.resolver !== dispute.resolver) {
    throw new LifecycleError('the resolver is already set');
  }
  if (options.resolveBy !== undefined && options.resolveBy !== dispute.resolveBy) {
    throw new LifecycleError('the dispute deadline is already set');
  }
  if (parseTime(options.now, 'now') > parseTime(dispute.resolveBy, 'resolveBy')) {
    base.evidence.timeoutResult = 'unresolved';
    base.evidence.escrowDisposition = 'held';
    return {
      ...base,
      state: 'unresolved',
      verificationMethod: 'lifecycle',
      verificationConfidence: TIMEOUT_CONFIDENCE,
      resolver: dispute.resolver,
      resolveBy: dispute.resolveBy,
    };
  }
  return {
    ...base,
    state: 'disputed',
    verificationMethod: 'lifecycle',
    resolver: dispute.resolver,
    resolveBy: dispute.resolveBy,
  };
}

export function findStage(
  history: readonly LifecycleTransition[], stage: LifecycleStage,
): LifecycleTransition|undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const item = history[index];
    if (item?.to === stage) return item;
  }
  return undefined;
}

export function disputeRecord(
  history: readonly LifecycleTransition[],
): {resolver: string; resolveBy: string} {
  const opened = findStage(history, 'dispute_opened');
  const resolver = opened?.evidence.resolver;
  const resolveBy = opened?.evidence.resolveBy;
  if (typeof resolver !== 'string' || resolver === '' || typeof resolveBy !== 'string') {
    throw new LifecycleError('a dispute names a resolver and a deadline');
  }
  return {resolver, resolveBy};
}
