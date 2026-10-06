/**
 * @fileoverview Runs one lifecycle outcome through the shared event flow.
 * Pending, disputed, cancelled, and unresolved outcomes emit no events.
 * The caller passes the scoring and fee policies. This file holds no
 * scoring math and no fee math.
 */

import {
  applyEventsToStates, outcomeToEvents, refreshTermsDecisions,
} from './event-flow';
import type {FeeTermsPolicy} from './fees-policy';
import type {PairDecay} from './pair-decay';
import type {ScoringPolicy} from './scoring';
import type {
  Entity, MarketplaceTransaction, Outcome, ReliabilityEvent,
  ReliabilityState, TermsDecision,
} from './types';

/** Events, per-role states, and stub or real terms decisions. */
export interface LifecycleFlowResult {
  events: ReliabilityEvent[];
  states: ReliabilityState[];
  decisions: TermsDecision[];
}

/** Stored history for an incremental projection. Event ids mark prior writes. */
export interface LifecycleFlowHistory {
  states?: ReliabilityState[];
  appliedEventIds?: ReadonlySet<string>;
}

function stateKey(state: Pick<ReliabilityState, 'entityId'|'category'|'role'>): string {
  return JSON.stringify([state.entityId, state.category, state.role]);
}

/**
 * Builds reliability events from one outcome, applies them, and refreshes
 * terms decisions. Pass entity rows when KYC tier should affect terms.
 * Supply stored states and event ids to apply only new events. The result
 * includes current states and terms for all events, including prior writes.
 */
export function flowLifecycleOutcome(
  transaction: MarketplaceTransaction,
  outcome: Outcome,
  scoring: ScoringPolicy,
  decays: PairDecay,
  fees: FeeTermsPolicy,
  now: string,
  entities: ReadonlyMap<string, Entity> = new Map(),
  history: LifecycleFlowHistory = {},
): LifecycleFlowResult {
  const events = outcomeToEvents(transaction, outcome);
  const counterpartyByEvent = new Map<string, string>();
  for (const event of events) {
    const other = transaction.participants.find(
      (participant) => participant.entityId !== event.entityId,
    );
    if (other) counterpartyByEvent.set(event.id, other.entityId);
  }
  const previous = history.states ?? [];
  const newEvents = events.filter((event) => !history.appliedEventIds?.has(event.id));
  const updated = applyEventsToStates(
    previous, newEvents, scoring, decays, new Map(), counterpartyByEvent, now,
  );
  const byKey = new Map([...previous, ...updated].map((state) => [stateKey(state), state]));
  const states = events.map((event) => {
    const state = byKey.get(stateKey(event));
    if (!state) throw new Error(`missing reliability state for event ${event.id}`);
    return state;
  });
  const decisions = refreshTermsDecisions(
    states, scoring, fees, entities, new Map(), new Map(), now,
  );
  return {events, states, decisions};
}
