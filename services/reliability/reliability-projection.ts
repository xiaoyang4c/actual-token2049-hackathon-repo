/**
 * @fileoverview Cumulative reliability projection for one outcome on the
 * shared store. It follows the same rules as LifecycleService.view:
 *
 * - Start from the stored per-role state.
 * - Apply only events that the store does not have yet.
 * - Rebuild a missing state from recorded events (older writes could leave
 *   events without a posterior).
 *
 * `extraEvents` go through the same scoring policy. The contract lifecycle
 * uses them for an ignored ruling. The v1 lifecycle service can move to this
 * module later; the logic is the same.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {outcomeToEvents, refreshTermsDecisions} from '../../packages/reliability/src/event-flow';
import {flowLifecycleOutcome} from '../../packages/reliability/src/lifecycle-flow';
import type {
  MarketplaceTransaction, Outcome, ReliabilityEvent, ReliabilityState, TermsDecision,
} from '../../packages/reliability/src/types';
import type {ReliabilityPolicies} from './policies';

export interface ProjectionResult {
  events: ReliabilityEvent[];
  states: ReliabilityState[];
  decisions: TermsDecision[];
}

/** Writes events, states, and terms decisions. Run it inside one store transaction. */
export function projectOutcome(
  store: AgentStore,
  policies: ReliabilityPolicies,
  transaction: MarketplaceTransaction,
  outcome: Outcome,
  now: string,
  extraEvents: readonly ReliabilityEvent[] = [],
): ProjectionResult {
  const entities = new Map(store.listEntities().map((entity) => [entity.id, entity]));
  const appliedEventIds = new Set(store.listReliabilityEventsForTransaction(transaction.id).map((event) => event.id));
  const recoveredEventIds = new Set<string>();
  const startingState = (event: ReliabilityEvent): ReliabilityState|undefined => {
    const stored = store.getReliabilityState(event.entityId, event.category, event.role);
    if (stored) return stored;
    const recorded = store.listReliabilityEventsForState(event.entityId, event.category, event.role)
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
    const first = recorded[0];
    if (!first) return undefined;
    recoveredEventIds.add(event.id);
    const initial = policies.scoring.initialState(event.entityId, event.category, event.role, first.createdAt);
    return recorded.reduce((previous, item) => policies.scoring.applyEvent(previous, item, item.createdAt), initial);
  };

  // Outcome events: the shared flow, with stored history.
  const history = outcomeToEvents(transaction, outcome).flatMap((event) => {
    const state = startingState(event);
    return state ? [state] : [];
  });
  const flowed = flowLifecycleOutcome(
    transaction, outcome, policies.scoring, policies.decay, policies.fees, now, entities,
    {states: history, appliedEventIds},
  );
  const result: ProjectionResult = {events: [], states: [], decisions: []};
  const write = (event: ReliabilityEvent, state: ReliabilityState, decision: TermsDecision): void => {
    const applied = appliedEventIds.has(event.id);
    if (applied && !recoveredEventIds.has(event.id)) return;
    if (!applied) store.insertReliabilityEvent(event);
    store.saveReliabilityState(state);
    store.insertTermsDecision(decision);
    result.events.push(event);
    result.states.push(state);
    result.decisions.push(decision);
  };
  flowed.events.forEach((event, index) => {
    const state = flowed.states[index];
    const decision = flowed.decisions[index];
    if (!state || !decision) throw new Error('incomplete reliability projection');
    write(event, state, decision);
  });

  // Extra events: one at a time, each from the latest state of its role.
  for (const event of extraEvents) {
    if (appliedEventIds.has(event.id)) continue;
    const start = store.getReliabilityState(event.entityId, event.category, event.role) ??
      startingState(event) ??
      policies.scoring.initialState(event.entityId, event.category, event.role, now);
    const state = policies.scoring.applyEvent(start, event, now);
    const [decision] = refreshTermsDecisions([state], policies.scoring, policies.fees, entities, new Map(), new Map(), now);
    if (!decision) throw new Error('incomplete reliability projection');
    write(event, state, decision);
  }
  return result;
}
