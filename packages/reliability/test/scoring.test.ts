/**
 * @fileoverview Pins the scoring seam shape for lane 1.
 */

import {describe, expect, test} from 'bun:test';
import {BetaScoringPolicy, StubScoringPolicy} from '../src/scoring';
import type {ReliabilityEvent} from '../src/types';

const NOW = '2026-10-06T00:00:00.000Z';

describe('StubScoringPolicy', () => {
  test('starts a new entity at one alpha and one beta', () => {
    const scoring = new StubScoringPolicy();
    const state = scoring.initialState(
      'entity-new', 'compute', 'seller', NOW,
    );
    expect(state).toEqual({
      entityId: 'entity-new', category: 'compute', role: 'seller',
      alpha: 1, beta: 1, eventCount: 0, updatedAt: NOW,
    });
  });

  test('adds success to alpha and failure to beta', () => {
    const scoring = new StubScoringPolicy();
    const start = scoring.initialState('e1', 'payment', 'buyer', NOW);
    const afterSuccess = scoring.applyEvent(start, {
      id: 'tx:e1:buyer', transactionId: 'tx', entityId: 'e1',
      category: 'payment', role: 'buyer', outcome: 'success', evidence: {},
      verificationMethod: 'payment-settlement', createdAt: NOW,
    }, NOW);
    expect(afterSuccess.alpha).toBe(2);
    expect(afterSuccess.beta).toBe(1);
    expect(afterSuccess.eventCount).toBe(1);
  });

  test('exposes value, lower bound, and confidence separately', () => {
    const scoring = new StubScoringPolicy();
    const view = scoring.scoreView({
      entityId: 'e1', category: 'compute', role: 'seller',
      alpha: 3, beta: 1, eventCount: 2, updatedAt: NOW,
    });
    expect(view.value).toBe(0.75);
    expect(view.lowerBound).toBeLessThan(view.value);
    expect(view.confidence).toBeGreaterThan(0);
    expect(view.eventCount).toBe(2);
  });
});

function event(overrides: Partial<ReliabilityEvent> = {}): ReliabilityEvent {
  return {
    id: 'tx:seller:seller', transactionId: 'tx', entityId: 'seller',
    category: 'delivery', role: 'seller', outcome: 'success', evidence: {},
    verificationMethod: 'lifecycle', value: 1000, createdAt: NOW, ...overrides,
  };
}

describe('BetaScoringPolicy', () => {
  const scoring = new BetaScoringPolicy();
  const ln2 = Math.log(2);

  test('weights a verified event by ln(1 + v / v0)', () => {
    const weight = scoring.baseWeight(event({value: 1000}));
    expect(weight).toMatchObject({eligible: true, valueScale: 1000, reason: 'applied'});
    expect(weight.weight).toBeCloseTo(ln2, 12);
    expect(scoring.baseWeight(event({value: 3000})).weight).toBeCloseTo(Math.log(4), 12);
  });

  test('gives unverified, unknown-value, and zero-value events no weight', () => {
    expect(scoring.baseWeight(event({verificationMethod: 'unverified'})))
      .toMatchObject({eligible: false, weight: 0, reason: 'unverified'});
    expect(scoring.baseWeight(event({value: undefined})))
      .toMatchObject({eligible: true, weight: 0, reason: 'value_missing'});
    expect(scoring.baseWeight(event({value: 0})))
      .toMatchObject({weight: 0, reason: 'value_zero'});
  });

  test('adds the weight to alpha or beta and counts only positive weights', () => {
    const start = scoring.initialState('seller', 'delivery', 'seller', NOW);
    const success = scoring.applyEvent(start, event(), NOW);
    expect(success.alpha).toBeCloseTo(1 + ln2, 12);
    expect(success.beta).toBe(1);
    expect(success.eventCount).toBe(1);
    const failure = scoring.applyEvent(success, event({outcome: 'failure'}), NOW, ln2 / 2);
    expect(failure.beta).toBeCloseTo(1 + ln2 / 2, 12);
    expect(failure.eventCount).toBe(2);
    const ignored = scoring.applyEvent(failure, event({value: undefined}), NOW);
    expect(ignored).toMatchObject({alpha: failure.alpha, beta: failure.beta, eventCount: 2});
    expect(() => scoring.applyEvent(start, event(), NOW, -1)).toThrow();
  });

  test('reproduces the worked example score view', () => {
    const view = scoring.scoreView({
      entityId: 'seller', category: 'delivery', role: 'seller',
      alpha: 1 + ln2, beta: 1 + ln2 / 2, eventCount: 2, updatedAt: NOW,
    });
    expect(view.value).toBeCloseTo(0.557007, 6);
    expect(view.lowerBound).toBeCloseTo(0.135821, 6);
    expect(view.confidence).toBeCloseTo(0.09418, 5);
  });

  test('uses the fifth percentile, not the mean, for a new entity', () => {
    const view = scoring.scoreView(scoring.initialState('new', 'payment', 'buyer', NOW));
    expect(view.value).toBe(0.5);
    expect(view.lowerBound).toBeCloseTo(0.05, 10);
    expect(view.confidence).toBe(0);
  });

  test('rejects invalid parameters', () => {
    expect(() => new BetaScoringPolicy({
      ...scoring.params, valueScales: {...scoring.params.valueScales, delivery: 0},
    })).toThrow();
    expect(() => new BetaScoringPolicy({...scoring.params, lowerQuantile: 1})).toThrow();
  });
});
