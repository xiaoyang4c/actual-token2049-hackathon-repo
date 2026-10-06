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

/**
 * Builds reliability events from one outcome, applies them, and refreshes
 * terms decisions. Pass entity rows when KYC tier should affect terms.
 */
export function flowLifecycleOutcome(
  transaction: MarketplaceTransaction,
  outcome: Outcome,
  scoring: ScoringPolicy,
  decays: PairDecay,
  fees: FeeTermsPolicy,
  now: string,
  entities: ReadonlyMap<string, Entity> = new Map(),
): LifecycleFlowResult {
  const events = outcomeToEvents(transaction, outcome);
  const counterpartyByEvent = new Map<string, string>();
  for (const event of events) {
    const other = transaction.participants.find(
      (participant) => participant.entityId !== event.entityId,
    );
    if (other) counterpartyByEvent.set(event.id, other.entityId);
  }
  const states = applyEventsToStates(
    [], events, scoring, decays, new Map(), counterpartyByEvent, now,
  );
  const decisions = refreshTermsDecisions(
    states, scoring, fees, entities, new Map(), new Map(), now,
  );
  return {events, states, decisions};
}
