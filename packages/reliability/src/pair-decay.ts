/**
 * @fileoverview Repeat-pair decay for the math lane.
 *
 * Contract: decayFactor(n) maps the count n of earlier eligible
 * transactions between the same pair in the same category to a weight
 * factor in (0, 1]. It equals 1 for n = 0 and decreases as n grows, so
 * farming repeat transactions between one pair yields diminishing
 * reliability gains. effectiveWeight multiplies a value-scaled base
 * weight w by that factor.
 *
 * The hyperbolic curve D(n) = 1 / (1 + lambda * n) is the proposal in
 * docs/reliability-math.md. The decay rate and the pair direction are
 * defaults. The product owner has not selected them.
 */

import type {ReliabilityCategory} from './types';

export const STUB_PAIR_DECAY_VERSION = 'pair-decay-stub-v0';
export const HYPERBOLIC_PAIR_DECAY_VERSION = 'pair-decay-hyperbolic-v1';

/** Directed pairs count buyer A to seller B apart from buyer B to seller A. */
export type PairDirection = 'directed'|'undirected';

/** Diminishing returns for repeat pairs. Lane 1 owns the curve. */
export interface PairDecay {
  readonly version: string;
  /** Pair direction for the pair key. */
  readonly direction: PairDirection;
  /** Weight factor from zero to one for the next event in a pair. */
  decayFactor(pairCount: number): number;
  /** Effective event weight after decay. */
  effectiveWeight(baseWeight: number, pairCount: number): number;
}

/** Pair key: buyer, seller, and category. Undirected keys sort the two ids. */
export function pairKeyFor(
  buyerId: string, sellerId: string, category: ReliabilityCategory,
  direction: PairDirection,
): string {
  const ids = direction === 'undirected' ? [buyerId, sellerId].sort() : [buyerId, sellerId];
  return JSON.stringify([...ids, category]);
}

function assertPairCount(pairCount: number): void {
  if (!Number.isSafeInteger(pairCount) || pairCount < 0) {
    throw new Error('pairCount must be a non-negative integer');
  }
}

function assertBaseWeight(baseWeight: number): void {
  if (!Number.isFinite(baseWeight) || baseWeight < 0) {
    throw new Error('baseWeight must be a finite non-negative number');
  }
}

/** Deterministic placeholder. Not the agreed farming control. */
export class StubPairDecay implements PairDecay {
  readonly version = STUB_PAIR_DECAY_VERSION;
  readonly direction: PairDirection = 'directed';

  decayFactor(pairCount: number): number {
    assertPairCount(pairCount);
    return 1 / (1 + pairCount);
  }

  effectiveWeight(baseWeight: number, pairCount: number): number {
    assertBaseWeight(baseWeight);
    return baseWeight * this.decayFactor(pairCount);
  }
}

/** Parameters of the hyperbolic decay curve. */
export interface HyperbolicPairDecayParams {
  readonly version: string;
  /** Decay rate lambda > 0. */
  readonly rate: number;
  readonly direction: PairDirection;
}

/** Default parameters. Not a product decision. */
export const DEFAULT_PAIR_DECAY_PARAMS: HyperbolicPairDecayParams = {
  version: HYPERBOLIC_PAIR_DECAY_VERSION,
  rate: 1,
  direction: 'directed',
};

/** D(n) = 1 / (1 + lambda * n). */
export class HyperbolicPairDecay implements PairDecay {
  readonly version: string;
  readonly direction: PairDirection;

  constructor(readonly params: HyperbolicPairDecayParams = DEFAULT_PAIR_DECAY_PARAMS) {
    if (!(params.rate > 0) || !Number.isFinite(params.rate)) {
      throw new Error('decay rate must be finite and positive');
    }
    this.version = params.version;
    this.direction = params.direction;
  }

  decayFactor(pairCount: number): number {
    assertPairCount(pairCount);
    return 1 / (1 + this.params.rate * pairCount);
  }

  effectiveWeight(baseWeight: number, pairCount: number): number {
    assertBaseWeight(baseWeight);
    return baseWeight * this.decayFactor(pairCount);
  }
}
