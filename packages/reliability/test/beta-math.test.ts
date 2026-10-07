/**
 * @fileoverview Beta distribution helpers against closed forms and the
 * worked example in docs/reliability-math.md.
 */

import {describe, expect, test} from 'bun:test';
import {betaCdf, betaQuantile, logGamma} from '../src/beta-math';

describe('beta math', () => {
  test('logGamma matches factorials and the half-integer value', () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(0.5 * Math.log(Math.PI), 12);
  });

  test('betaCdf matches closed forms', () => {
    // Beta(a, 1) has CDF x^a. Beta(2, 5) at 0.3 is 0.579825.
    expect(betaCdf(0.4, 2.5, 1)).toBeCloseTo(Math.pow(0.4, 2.5), 12);
    expect(betaCdf(0.3, 2, 5)).toBeCloseTo(0.579825, 9);
    expect(betaCdf(0, 2, 2)).toBe(0);
    expect(betaCdf(1, 2, 2)).toBe(1);
  });

  test('the fifth percentile of the uniform prior is 0.05', () => {
    expect(betaQuantile(0.05, 1, 1)).toBeCloseTo(0.05, 12);
  });

  test('reproduces the worked example lower bounds', () => {
    const ln2 = Math.log(2);
    expect(betaQuantile(0.05, 1 + ln2, 1)).toBeCloseTo(0.170448, 6);
    expect(betaQuantile(0.05, 1 + ln2, 1 + ln2 / 2)).toBeCloseTo(0.135821, 6);
  });

  test('inverts the CDF for skewed shapes', () => {
    for (const [alpha, beta] of [[50, 2], [0.3, 0.4], [1000, 10], [3, 40]] as const) {
      const quantile = betaQuantile(0.05, alpha, beta);
      expect(quantile).toBeGreaterThanOrEqual(0);
      expect(quantile).toBeLessThanOrEqual(1);
      expect(betaCdf(quantile, alpha, beta)).toBeCloseTo(0.05, 9);
    }
  });

  test('rejects invalid shapes and probabilities', () => {
    expect(() => betaQuantile(0.05, 0, 1)).toThrow();
    expect(() => betaQuantile(1.5, 1, 1)).toThrow();
    expect(() => logGamma(-1)).toThrow();
  });
});
