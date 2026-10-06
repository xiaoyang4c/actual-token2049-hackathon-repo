/**
 * @fileoverview Pins the pair-decay seam shape for lane 1.
 */

import {describe, expect, test} from 'bun:test';
import {StubPairDecay} from '../src/pair-decay';

describe('StubPairDecay', () => {
  test('returns full weight for a first-time pair', () => {
    const decay = new StubPairDecay();
    expect(decay.decayFactor(0)).toBe(1);
    expect(decay.effectiveWeight(1, 0)).toBe(1);
  });

  test('lowers weight for repeat pairs', () => {
    const decay = new StubPairDecay();
    expect(decay.decayFactor(11)).toBeLessThan(decay.decayFactor(1));
    expect(decay.effectiveWeight(1, 11)).toBeLessThan(0.1);
  });

  test('rejects a negative pair count', () => {
    const decay = new StubPairDecay();
    expect(() => decay.decayFactor(-1)).toThrow();
  });
});
