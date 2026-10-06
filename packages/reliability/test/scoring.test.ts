/**
 * @fileoverview Pins the scoring seam shape for lane 1.
 */

import {describe, expect, test} from 'bun:test';
import {StubScoringPolicy} from '../src/scoring';

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
