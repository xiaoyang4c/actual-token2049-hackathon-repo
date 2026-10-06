/**
 * @fileoverview Pins the shared event flow from outcome to terms and fee.
 */

import {describe, expect, test} from 'bun:test';
import {
  applyEventsToStates,
  outcomeToEvents,
  refreshTermsDecisions,
} from '../src/event-flow';
import {StubFeeTermsPolicy} from '../src/fees-policy';
import {
  FIXTURE_ENTITIES,
  OUTCOME_BUYER_FAULT,
  OUTCOME_NO_FAULT,
  OUTCOME_SELLER_FAULT,
  OUTCOME_SERVICE,
  TX_INVOICE,
  TX_SERVICE,
} from '../src/fixtures/index';
import {StubPairDecay} from '../src/pair-decay';
import {StubScoringPolicy} from '../src/scoring';

const NOW = '2026-10-06T00:00:00.000Z';

describe('reliability event flow', () => {
  test('credits both roles on success', () => {
    expect(OUTCOME_SERVICE.fault).toBeUndefined();
    const events = outcomeToEvents(TX_SERVICE, OUTCOME_SERVICE);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.role)).toEqual(['buyer', 'seller']);
    expect(events.map((event) => event.outcome)).toEqual([
      'success', 'success',
    ]);
    expect(events[0]?.category).toBe('fulfillment');
    expect(events[0]?.entityId).toBe('entity-new');
    expect(events[1]?.entityId).toBe('entity-established');
  });

  test('fails only the seller role when the seller is at fault', () => {
    const events = outcomeToEvents(TX_SERVICE, {
      ...OUTCOME_SELLER_FAULT,
      evidence: {...OUTCOME_SELLER_FAULT.evidence, fault: 'buyer'},
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe('entity-established');
    expect(events[0]?.role).toBe('seller');
    expect(events[0]?.outcome).toBe('failure');
    expect(events[0]?.category).toBe('fulfillment');
    const scoring = new StubScoringPolicy();
    const buyerState = scoring.initialState(
      'entity-established', 'fulfillment', 'buyer', NOW,
    );
    const states = applyEventsToStates(
      [buyerState], events, scoring, new StubPairDecay(),
      new Map(), new Map(), NOW,
    );
    expect(states.map((state) => `${state.entityId}:${state.role}`)).toEqual([
      'entity-established:seller',
    ]);
    expect(states[0]?.alpha).toBe(1);
    expect(states[0]?.beta).toBe(2);
    expect(buyerState.eventCount).toBe(0);
  });

  test('fails only the buyer role when the buyer is at fault', () => {
    const events = outcomeToEvents(TX_INVOICE, OUTCOME_BUYER_FAULT);
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe('entity-established');
    expect(events[0]?.role).toBe('buyer');
    expect(events[0]?.outcome).toBe('failure');
    expect(events[0]?.category).toBe('payment');
    const states = applyEventsToStates(
      [], events, new StubScoringPolicy(), new StubPairDecay(),
      new Map(), new Map(), NOW,
    );
    expect(states.map((state) => `${state.entityId}:${state.role}`)).toEqual([
      'entity-established:buyer',
    ]);
    expect(states[0]?.beta).toBe(2);
  });

  test('emits nothing for no fault, a mutual end, or an open state', () => {
    expect(outcomeToEvents(TX_SERVICE, OUTCOME_NO_FAULT)).toEqual([]);
    expect(outcomeToEvents(TX_SERVICE, {
      ...OUTCOME_SERVICE, state: 'failed',
    })).toEqual([]);
    expect(outcomeToEvents(TX_SERVICE, {
      ...OUTCOME_SERVICE, state: 'cancelled', fault: 'none',
    })).toEqual([]);
    const openStates = [
      'pending', 'disputed', 'cancelled', 'unresolved',
    ] as const;
    for (const state of openStates) {
      expect(outcomeToEvents(TX_SERVICE, {...OUTCOME_SERVICE, state}))
        .toEqual([]);
    }
  });

  test('flows from outcome to score to terms and fee', () => {
    const scoring = new StubScoringPolicy();
    const events = outcomeToEvents(TX_SERVICE, OUTCOME_SERVICE);
    const states = applyEventsToStates(
      [], events, scoring, new StubPairDecay(), new Map(), new Map(), NOW,
    );
    expect(states).toHaveLength(2);
    expect(states.every((state) => state.eventCount === 1)).toBe(true);
    const decisions = refreshTermsDecisions(
      states, scoring, new StubFeeTermsPolicy(),
      new Map(FIXTURE_ENTITIES.map((entity) => [entity.id, entity])),
      new Map(), new Map(), NOW,
    );
    expect(decisions).toHaveLength(2);
    expect(decisions.every(
      (decision) => decision.policyVersion === 'fee-terms-stub-v0',
    )).toBe(true);
  });
});
