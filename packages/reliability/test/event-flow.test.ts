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
  OUTCOME_SERVICE,
  TX_SERVICE,
} from '../src/fixtures/index';
import {StubPairDecay} from '../src/pair-decay';
import {StubScoringPolicy} from '../src/scoring';

const NOW = '2026-10-06T00:00:00.000Z';

describe('reliability event flow', () => {
  test('emits one event per participant role and skips pending', () => {
    const events = outcomeToEvents(TX_SERVICE, OUTCOME_SERVICE);
    expect(events).toHaveLength(2);
    expect(events.map((event) => event.role)).toEqual(['buyer', 'seller']);
    expect(events[0].category).toBe('fulfillment');
    const pending = outcomeToEvents(TX_SERVICE, {
      ...OUTCOME_SERVICE, state: 'pending',
    });
    expect(pending).toEqual([]);
    const disputed = outcomeToEvents(TX_SERVICE, {
      ...OUTCOME_SERVICE, state: 'disputed',
    });
    expect(disputed).toEqual([]);
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
