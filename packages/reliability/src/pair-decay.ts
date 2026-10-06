/**
 * @fileoverview Repeat-pair decay seam for the math lane.
 *
 * Contract: decayFactor(n) maps the count n of past verified events
 * between the same ordered pair of entities to a weight factor in
 * (0, 1]. It equals 1 for n = 0 and decreases as n grows, so farming
 * repeat transactions between one pair yields diminishing reliability
 * gains. effectiveWeight multiplies a value-scaled base weight w by
 * that factor. The math lane owns the real curve and the choice of
 * directed versus undirected pair counts.
 *
 * TODO(math-lane): implement the agreed diminishing returns curve here.
 * Keep the interface shape. This stub uses 1 / (1 + n).
 */

export const STUB_PAIR_DECAY_VERSION = 'pair-decay-stub-v0';

/**
 * Diminishing returns for repeat pairs. Lane 1 owns the real curve.
 * The stub scales weight by 1 / (1 + pairCount).
 */
export interface PairDecay {
  readonly version: string;
  /** Weight factor from zero to one for the next event in a pair. */
  decayFactor(pairCount: number): number;
  /** Effective event weight after decay. Stub ignores value scaling. */
  effectiveWeight(baseWeight: number, pairCount: number): number;
}

/** Deterministic placeholder. Not the agreed farming control. */
export class StubPairDecay implements PairDecay {
  readonly version = STUB_PAIR_DECAY_VERSION;

  decayFactor(pairCount: number): number {
    if (!Number.isSafeInteger(pairCount) || pairCount < 0) {
      throw new Error('pairCount must be a non-negative integer');
    }
    return 1 / (1 + pairCount);
  }

  effectiveWeight(baseWeight: number, pairCount: number): number {
    if (!Number.isFinite(baseWeight) || baseWeight < 0) {
      throw new Error('baseWeight must be a finite non-negative number');
    }
    return baseWeight * this.decayFactor(pairCount);
  }
}
