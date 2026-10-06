/**
 * @fileoverview Scoring seam for the math lane (reliability core).
 *
 * Contract for a mathematically strong reader with no other context.
 *
 * Intended model (NOT implemented here):
 * - Per entity, per category, per role, keep a Beta posterior with
 *   parameters alpha > 0 and beta > 0. Start new triples at alpha = 1
 *   and beta = 1. Count every applied event in eventCount.
 * - Display value: posterior mean r = alpha / (alpha + beta).
 * - Policy input: lower credible bound LB, the 5th percentile of the
 *   Beta posterior. Policy never uses the mean. ScoreView carries both.
 * - Confidence: low for new entities, near one after many events.
 *   The stub uses eventCount / (eventCount + 10). Keep value and
 *   confidence separate in every read model.
 * - Value scaling: a verified success adds w to alpha and a verified
 *   failure adds w to beta, with w = log(1 + v / v0) for transaction
 *   value v and scale v0. No strong change comes from unsupported
 *   self-reported info: unverified events carry w = 0.
 * - Exposure cap: maximum recommended exposure as a function of LB
 *   (prototype formula, labelled as such when you add it).
 * - Repeat pairs: multiply w by the PairDecay factor for the pair.
 *   Events update only their own category. One category never proves
 *   another. Overall scores are display only.
 *
 * TODO(math-lane): implement the model above in this file. Keep the
 * interface shape: initialState, applyEvent, scoreView, version.
 * This stub only pins the interface with unit weights.
 */

import type {
  EntityRole, ReliabilityCategory, ReliabilityEvent, ReliabilityState,
  ScoreView,
} from './types';

export const STUB_SCORING_VERSION = 'scoring-stub-v0';

/** Starting posterior for a new entity, category, and role. */
export function stubInitialState(
  entityId: string,
  category: ReliabilityCategory,
  role: EntityRole,
  now: string,
): ReliabilityState {
  return {
    entityId, category, role, alpha: 1, beta: 1, eventCount: 0,
    updatedAt: now,
  };
}

/**
 * Reliability core seam. Lane 1 owns this file's real implementation.
 * The stub adds one to alpha on success and one to beta on failure.
 */
export interface ScoringPolicy {
  readonly version: string;
  initialState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
    now: string,
  ): ReliabilityState;
  applyEvent(
    state: ReliabilityState, event: ReliabilityEvent, now: string,
  ): ReliabilityState;
  scoreView(state: ReliabilityState): ScoreView;
}

/** Deterministic placeholder. Not the Beta lower-bound model. */
export class StubScoringPolicy implements ScoringPolicy {
  readonly version = STUB_SCORING_VERSION;

  initialState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
    now: string,
  ): ReliabilityState {
    return stubInitialState(entityId, category, role, now);
  }

  applyEvent(
    state: ReliabilityState, event: ReliabilityEvent, now: string,
  ): ReliabilityState {
    return {
      ...state,
      alpha: state.alpha + (event.outcome === 'success' ? 1 : 0),
      beta: state.beta + (event.outcome === 'failure' ? 1 : 0),
      eventCount: state.eventCount + 1,
      updatedAt: now,
    };
  }

  scoreView(state: ReliabilityState): ScoreView {
    const total = state.alpha + state.beta;
    const value = state.alpha / total;
    // Placeholder margin only. TODO(lane-1): use the 5th percentile.
    const confidence = state.eventCount / (state.eventCount + 10);
    return {
      entityId: state.entityId, category: state.category, role: state.role,
      value, lowerBound: value * confidence, confidence,
      eventCount: state.eventCount,
    };
  }
}
