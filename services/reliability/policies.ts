/**
 * @fileoverview Composition seam for scoring, pair decay, and fee policies.
 * Lane implementations can replace the defaults without changing handlers.
 */

import {
  CurveFeeTermsPolicy, StubFeeTermsPolicy, type FeeTermsPolicy,
} from '../../packages/reliability/src/fees-policy';
import {
  HyperbolicPairDecay, StubPairDecay, type PairDecay,
} from '../../packages/reliability/src/pair-decay';
import {
  BetaScoringPolicy, StubScoringPolicy, type ScoringPolicy,
} from '../../packages/reliability/src/scoring';

/** Policies shared by fixture reads and lifecycle projections. */
export interface ReliabilityPolicies {
  readonly scoring: ScoringPolicy;
  readonly decay: PairDecay;
  readonly fees: FeeTermsPolicy;
}

/**
 * Current defaults: the weighted Beta model, hyperbolic pair decay, and
 * the fee curve. Their parameters are defaults, not product decisions.
 */
export const DEFAULT_RELIABILITY_POLICIES: ReliabilityPolicies = {
  scoring: new BetaScoringPolicy(),
  decay: new HyperbolicPairDecay(),
  fees: new CurveFeeTermsPolicy(),
};

/** False until the product owner selects the policy parameters. */
export const POLICY_PARAMETERS_SELECTED = false;

/** Unit-weight placeholders. Tests of cumulative mechanics use them. */
export const STUB_RELIABILITY_POLICIES: ReliabilityPolicies = {
  scoring: new StubScoringPolicy(),
  decay: new StubPairDecay(),
  fees: new StubFeeTermsPolicy(),
};
