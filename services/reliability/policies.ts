/**
 * @fileoverview Composition seam for scoring, pair decay, and fee policies.
 * Lane implementations can replace the defaults without changing handlers.
 */

import {
  StubFeeTermsPolicy, type FeeTermsPolicy,
} from '../../packages/reliability/src/fees-policy';
import {
  StubPairDecay, type PairDecay,
} from '../../packages/reliability/src/pair-decay';
import {
  StubScoringPolicy, type ScoringPolicy,
} from '../../packages/reliability/src/scoring';

/** Policies shared by fixture reads and lifecycle projections. */
export interface ReliabilityPolicies {
  readonly scoring: ScoringPolicy;
  readonly decay: PairDecay;
  readonly fees: FeeTermsPolicy;
}

/** Current defaults. The agreed scoring and fee curves are not implemented. */
export const DEFAULT_RELIABILITY_POLICIES: ReliabilityPolicies = {
  scoring: new StubScoringPolicy(),
  decay: new StubPairDecay(),
  fees: new StubFeeTermsPolicy(),
};
