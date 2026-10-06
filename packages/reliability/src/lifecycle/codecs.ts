/**
 * @fileoverview Lifecycle value validation and copies for stored records.
 */

import type {JsonValue} from '../types';
import {
  DELIVERY_TIERS, LifecycleError,
  type DeliveryTier, type LifecycleStage, type LifecycleTransition,
} from './contracts';

const STAGES: readonly LifecycleStage[] = [
  'offer_accepted', 'escrow_funded', 'delivery_confirmed', 'payment_settled',
  'dispute_opened', 'dispute_resolved', 'refunded', 'cancelled',
];

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type Evidence = LifecycleTransition['evidence'];

export function copyTransition(transition: LifecycleTransition): LifecycleTransition {
  return {
    transactionId: transition.transactionId,
    from: transition.from,
    to: transition.to,
    at: transition.at,
    evidence: {...transition.evidence},
  };
}

export function readTier(value: unknown, required: true): DeliveryTier;
export function readTier(value: unknown, required: false): DeliveryTier|undefined;
export function readTier(value: unknown, required: boolean): DeliveryTier|undefined {
  if (value === undefined || value === null) {
    if (required) throw new LifecycleError('delivery confirmation needs a delivery tier');
    return undefined;
  }
  for (const tier of DELIVERY_TIERS) {
    if (tier === value) return tier;
  }
  throw new LifecycleError('unknown delivery tier');
}

export function parseStage(value: string): LifecycleStage {
  for (const stage of STAGES) {
    if (stage === value) return stage;
  }
  throw new LifecycleError(`unknown lifecycle stage ${value}`);
}

export function parseTime(value: string, label: string): number {
  if (!TIMESTAMP.test(value)) {
    throw new LifecycleError(`${label} must be a UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new LifecycleError(`${label} must be a UTC timestamp`);
  }
  return parsed;
}

export function assertEvidence(evidence: Evidence): void {
  for (const value of Object.values(evidence)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) continue;
    throw new LifecycleError('evidence values must be scalars');
  }
}

export function parseEvidenceJson(raw: string): Evidence {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('evidence must be an object');
  }
  const evidence: Evidence = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value))) {
      evidence[key] = value;
      continue;
    }
    throw new LifecycleError('evidence values must be scalars');
  }
  return evidence;
}

export function copyTerms(
  terms: {[key: string]: JsonValue},
): {[key: string]: JsonValue} {
  const parsed: unknown = JSON.parse(JSON.stringify(terms));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleError('terms must be an object');
  }
  return parsed as {[key: string]: JsonValue};
}

export function assertJson(value: JsonValue, label: string): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new LifecycleError(`${label} must be finite`);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJson(item, label);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) assertJson(item, label);
  }
}

export function contractEnd(explicit: unknown, fromTerms: unknown): string|undefined {
  const value = explicit ?? fromTerms;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new LifecycleError('contractEnds must be a UTC timestamp');
  }
  parseTime(value, 'contractEnds');
  return value;
}
