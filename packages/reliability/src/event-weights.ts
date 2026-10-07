/**
 * @fileoverview Recorded event weights for the math lane.
 * A weight record stores every input of W = a * w * D(n) for one event:
 * the evidence eligibility, the normalized value, the value scale, the
 * pair count, the pair factor, and the policy versions. Reads and score
 * rebuilds reuse the record, so a read never changes a weight.
 */

import type {PairDecay} from './pair-decay';
import type {ScoringPolicy, WeightReason} from './scoring';
import type {EntityRole, ReliabilityCategory, ReliabilityEvent} from './types';

/** All inputs and the result of one event weight. */
export interface EventWeightRecord {
  eventId: string;
  transactionId: string;
  entityId: string;
  category: ReliabilityCategory;
  role: EntityRole;
  /** Key of the inputs below. A changed key needs a new weight. */
  inputsKey: string;
  eligible: boolean;
  normalizedValue: number|null;
  valueScale: number;
  valueWeight: number;
  /** Null when the event has no counterparty. */
  pairKey: string|null;
  /** Earlier eligible transactions for the pair. */
  pairCount: number;
  pairFactor: number;
  weight: number;
  reason: WeightReason;
  scoringVersion: string;
  decayVersion: string;
  computedAt: string;
}

/** Key of the event fields and policy versions that decide a weight. */
export function weightInputsKey(
  event: ReliabilityEvent, scoring: ScoringPolicy, decay: PairDecay,
): string {
  return JSON.stringify([
    event.verificationMethod, event.value ?? null, event.category,
    scoring.version, decay.version,
  ]);
}

/** Builds the weight record for one event from its pair position. */
export function composeEventWeight(
  event: ReliabilityEvent,
  scoring: ScoringPolicy,
  decay: PairDecay,
  pair: {key: string|null; count: number},
  computedAt: string,
): EventWeightRecord {
  const base = scoring.baseWeight(event);
  const pairFactor = decay.decayFactor(pair.count);
  return {
    eventId: event.id,
    transactionId: event.transactionId,
    entityId: event.entityId,
    category: event.category,
    role: event.role,
    inputsKey: weightInputsKey(event, scoring, decay),
    eligible: base.eligible,
    normalizedValue: base.normalizedValue,
    valueScale: base.valueScale,
    valueWeight: base.valueWeight,
    pairKey: pair.key,
    pairCount: pair.count,
    pairFactor,
    weight: decay.effectiveWeight(base.weight, pair.count),
    reason: base.reason,
    scoringVersion: scoring.version,
    decayVersion: decay.version,
    computedAt,
  };
}
