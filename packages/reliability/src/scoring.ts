/**
 * @fileoverview Scoring seam and the weighted Beta model (reliability core).
 *
 * Model (docs/reliability-math.md):
 * - Per entity, per category, per role, keep a Beta posterior with
 *   parameters alpha > 0 and beta > 0. Start new triples at alpha = 1
 *   and beta = 1.
 * - A verified success adds its weight W to alpha. A verified failure adds
 *   W to beta. W = a * w * D, with eligibility a, value weight
 *   w = ln(1 + v / v0), and the repeat-pair factor D from PairDecay.
 *   Unverified events and events without a value carry W = 0.
 *   eventCount counts applied events with positive weight only.
 * - Display value: posterior mean r = alpha / (alpha + beta).
 * - Policy input: lower credible bound L, the 5th percentile of the Beta
 *   posterior. Policy never uses the mean. ScoreView carries both.
 * - Display confidence: C = M / (M + kappa), with evidence mass
 *   M = alpha + beta - 2. C is a heuristic, not a probability.
 *
 * The parameters below are defaults. The product owner has not selected
 * the value scales or the display scale. Version them with the policy.
 */

import {betaQuantile} from './beta-math';
import type {
  EntityRole, ReliabilityCategory, ReliabilityEvent, ReliabilityState,
  ScoreView,
} from './types';

export const STUB_SCORING_VERSION = 'scoring-stub-v0';
export const BETA_SCORING_VERSION = 'beta-weighted-v1';

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

/** Why an event has its base weight. */
export type WeightReason = 'applied'|'unverified'|'value_missing'|'value_zero';

/** Event weight before the repeat-pair factor: W_base = a * w. */
export interface BaseEventWeight {
  /** Evidence eligibility a. False for unverified evidence. */
  eligible: boolean;
  /** Transaction value v in the accounting currency. Null when unknown. */
  normalizedValue: number|null;
  /** Category value scale v0. */
  valueScale: number;
  /** Value weight w = ln(1 + v / v0). Zero when the value is unknown. */
  valueWeight: number;
  /** a * w. */
  weight: number;
  reason: WeightReason;
}

/**
 * Reliability core seam. Lane 1 owns this file.
 * `applyEvent` adds `weight` to alpha or beta. When the caller omits
 * `weight`, the policy uses its base weight with no repeat-pair factor.
 */
export interface ScoringPolicy {
  readonly version: string;
  initialState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
    now: string,
  ): ReliabilityState;
  baseWeight(event: ReliabilityEvent): BaseEventWeight;
  applyEvent(
    state: ReliabilityState, event: ReliabilityEvent, now: string,
    weight?: number,
  ): ReliabilityState;
  scoreView(state: ReliabilityState): ScoreView;
}

/** Deterministic placeholder. Unit weights. Not the Beta lower-bound model. */
export class StubScoringPolicy implements ScoringPolicy {
  readonly version = STUB_SCORING_VERSION;

  initialState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
    now: string,
  ): ReliabilityState {
    return stubInitialState(entityId, category, role, now);
  }

  baseWeight(event: ReliabilityEvent): BaseEventWeight {
    return {
      eligible: true, normalizedValue: event.value ?? null, valueScale: 1,
      valueWeight: 1, weight: 1, reason: 'applied',
    };
  }

  /** The stub ignores `weight` and adds one. */
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
    // Placeholder margin only. BetaScoringPolicy uses the 5th percentile.
    const confidence = state.eventCount / (state.eventCount + 10);
    return {
      entityId: state.entityId, category: state.category, role: state.role,
      value, lowerBound: value * confidence, confidence,
      eventCount: state.eventCount,
    };
  }
}

/** Parameters of the weighted Beta model. */
export interface BetaScoringParams {
  readonly version: string;
  /** Currency of every transaction value. Convert before scoring. */
  readonly accountingCurrency: string;
  /** Value scale v0 for each category, in the accounting currency. */
  readonly valueScales: Readonly<Record<ReliabilityCategory, number>>;
  /** Display scale kappa for C = M / (M + kappa). */
  readonly displayScale: number;
  /** Quantile for the policy lower bound. */
  readonly lowerQuantile: number;
}

/**
 * Default parameters. Not a product decision.
 * USDM counts one to one with USD. Other assets need a recorded rate.
 */
export const DEFAULT_BETA_SCORING_PARAMS: BetaScoringParams = {
  version: BETA_SCORING_VERSION,
  accountingCurrency: 'USD',
  valueScales: {
    compute: 1000,
    payment: 1000,
    fulfillment: 1000,
    delivery: 1000,
    sla: 1000,
    dispute: 1000,
  },
  displayScale: 10,
  lowerQuantile: 0.05,
};

/** Weighted Beta model with the fifth-percentile lower bound. */
export class BetaScoringPolicy implements ScoringPolicy {
  readonly version: string;

  constructor(readonly params: BetaScoringParams = DEFAULT_BETA_SCORING_PARAMS) {
    for (const [category, scale] of Object.entries(params.valueScales)) {
      if (!(scale > 0) || !Number.isFinite(scale)) {
        throw new Error(`value scale for ${category} must be finite and positive`);
      }
    }
    if (!(params.displayScale > 0)) throw new Error('displayScale must be positive');
    if (!(params.lowerQuantile > 0 && params.lowerQuantile < 1)) {
      throw new Error('lowerQuantile must be between zero and one');
    }
    this.version = params.version;
  }

  initialState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
    now: string,
  ): ReliabilityState {
    return stubInitialState(entityId, category, role, now);
  }

  baseWeight(event: ReliabilityEvent): BaseEventWeight {
    const valueScale = this.params.valueScales[event.category];
    const value = event.value;
    const known = typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const normalizedValue = known ? value : null;
    if (event.verificationMethod === 'unverified') {
      return {eligible: false, normalizedValue, valueScale, valueWeight: 0, weight: 0, reason: 'unverified'};
    }
    if (!known) {
      return {eligible: true, normalizedValue, valueScale, valueWeight: 0, weight: 0, reason: 'value_missing'};
    }
    const valueWeight = Math.log1p(value / valueScale);
    return {
      eligible: true, normalizedValue, valueScale, valueWeight, weight: valueWeight,
      reason: valueWeight > 0 ? 'applied' : 'value_zero',
    };
  }

  applyEvent(
    state: ReliabilityState, event: ReliabilityEvent, now: string,
    weight: number = this.baseWeight(event).weight,
  ): ReliabilityState {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error('event weight must be finite and non-negative');
    }
    // Zero-weight events are not new evidence.
    if (weight === 0) return {...state, updatedAt: now};
    return {
      ...state,
      alpha: state.alpha + (event.outcome === 'success' ? weight : 0),
      beta: state.beta + (event.outcome === 'failure' ? weight : 0),
      eventCount: state.eventCount + 1,
      updatedAt: now,
    };
  }

  scoreView(state: ReliabilityState): ScoreView {
    const value = state.alpha / (state.alpha + state.beta);
    const mass = Math.max(0, state.alpha + state.beta - 2);
    return {
      entityId: state.entityId, category: state.category, role: state.role,
      value,
      lowerBound: betaQuantile(this.params.lowerQuantile, state.alpha, state.beta),
      confidence: mass / (mass + this.params.displayScale),
      eventCount: state.eventCount,
    };
  }
}
