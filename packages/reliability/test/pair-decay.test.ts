/**
 * @fileoverview Pins the pair-decay seam shape for lane 1.
 */

import {describe, expect, test} from 'bun:test';
import {HyperbolicPairDecay, StubPairDecay, pairKeyFor} from '../src/pair-decay';

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

describe('HyperbolicPairDecay', () => {
  test('follows D(n) = 1 / (1 + lambda n)', () => {
    const decay = new HyperbolicPairDecay();
    expect(decay.decayFactor(0)).toBe(1);
    expect(decay.decayFactor(1)).toBe(0.5);
    expect(decay.effectiveWeight(Math.log(2), 1)).toBeCloseTo(Math.log(2) / 2, 12);
    const steep = new HyperbolicPairDecay({...decay.params, rate: 3});
    expect(steep.decayFactor(1)).toBe(0.25);
    expect(() => new HyperbolicPairDecay({...decay.params, rate: 0})).toThrow();
  });

  test('builds directed and undirected pair keys per category', () => {
    expect(pairKeyFor('a', 'b', 'delivery', 'directed'))
      .not.toBe(pairKeyFor('b', 'a', 'delivery', 'directed'));
    expect(pairKeyFor('a', 'b', 'delivery', 'undirected'))
      .toBe(pairKeyFor('b', 'a', 'delivery', 'undirected'));
    expect(pairKeyFor('a', 'b', 'delivery', 'directed'))
      .not.toBe(pairKeyFor('a', 'b', 'payment', 'directed'));
  });
});
