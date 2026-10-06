/**
 * @fileoverview Shared event flow. This module is plumbing, not policy.
 * It wires the lane seams in order: outcome to reliability event to
 * score to terms and fee. It holds no scoring math, no fee math, and no
 * verification logic. Each step delegates to a lane-owned interface.
 */

import type {FeeTermsPolicy, TermsPolicyInput} from './fees-policy';
import type {PairDecay} from './pair-decay';
import type {ScoringPolicy} from './scoring';
import type {
  Entity, MarketplaceTransaction, Outcome, ReliabilityCategory,
  ReliabilityEvent, ReliabilityOutcome, ReliabilityState, ScoreView,
  TermsDecision, TransactionParticipant, TransactionType,
} from './types';

const CATEGORY_BY_TYPE: Record<TransactionType, ReliabilityCategory> = {
  goods: 'delivery',
  service: 'fulfillment',
  invoice: 'payment',
};

/** Category an event updates. Events update only applicable categories. */
export function categoryForType(type: TransactionType): ReliabilityCategory {
  return CATEGORY_BY_TYPE[type];
}

function toEvent(
  transaction: MarketplaceTransaction,
  outcome: Outcome,
  participant: TransactionParticipant,
  result: ReliabilityOutcome,
): ReliabilityEvent {
  return {
    id: `${transaction.id}:${participant.entityId}:${participant.role}`,
    transactionId: transaction.id,
    entityId: participant.entityId,
    category: categoryForType(transaction.type),
    role: participant.role,
    outcome: result,
    evidence: outcome.evidence,
    verificationMethod: outcome.verificationMethod,
    verificationConfidence: outcome.verificationConfidence,
    value: transaction.value,
    createdAt: outcome.decidedAt,
  };
}

/**
 * Builds reliability events for one outcome.
 * A successful outcome emits one success event per participant role.
 * A failed outcome emits one failure event for `fault` only.
 * `seller` fails the seller role. `buyer` fails the buyer role.
 * `none`, an empty fault, and every other state emit no events.
 * Pending is not successful. Disputed is not a final failure.
 * `cancelled` is a mutual end.
 */
export function outcomeToEvents(
  transaction: MarketplaceTransaction,
  outcome: Outcome,
): ReliabilityEvent[] {
  if (outcome.state === 'successful') {
    return transaction.participants.map((participant) =>
      toEvent(transaction, outcome, participant, 'success'));
  }
  if (outcome.state !== 'failed') return [];
  if (outcome.fault !== 'buyer' && outcome.fault !== 'seller') return [];
  const fault = outcome.fault;
  return transaction.participants
    .filter((participant) => participant.role === fault)
    .map((participant) =>
      toEvent(transaction, outcome, participant, 'failure'));
}

/**
 * Applies events to per-role states through the scoring and pair-decay
 * seams. Missing states start from the scoring policy initial state.
 * `pairCounts` maps "entityId:counterpartyId" to the repeat count.
 */
export function applyEventsToStates(
  states: ReliabilityState[],
  events: ReliabilityEvent[],
  scoring: ScoringPolicy,
  decays: PairDecay,
  pairCounts: ReadonlyMap<string, number>,
  counterpartyByEvent: ReadonlyMap<string, string>,
  now: string,
): ReliabilityState[] {
  const byKey = new Map(
    states.map((state) => [`${state.entityId}:${state.category}:${state.role}`, state]),
  );
  const updated: ReliabilityState[] = [];
  for (const event of events) {
    const key = `${event.entityId}:${event.category}:${event.role}`;
    const current = byKey.get(key) ??
      scoring.initialState(event.entityId, event.category, event.role, now);
    const counterparty = counterpartyByEvent.get(event.id) ?? '';
    const pairKey = `${event.entityId}:${counterparty}`;
    const pairCount = pairCounts.get(pairKey) ?? 0;
    // The stub weight stays one. Lane 1 owns value scaling and decay use.
    void decays.effectiveWeight(1, pairCount);
    const next = scoring.applyEvent(current, event, now);
    byKey.set(key, next);
    updated.push(next);
  }
  return updated;
}

/**
 * Refreshes terms and fee decisions for the scored states through the
 * fee policy seam. One decision per state.
 */
export function refreshTermsDecisions(
  states: ReliabilityState[],
  scoring: ScoringPolicy,
  fees: FeeTermsPolicy,
  entities: ReadonlyMap<string, Entity>,
  extraInputs: ReadonlyMap<string, {[key: string]: ReliabilityEvent['evidence'][string]}>,
  pairCounts: ReadonlyMap<string, number>,
  now: string,
): TermsDecision[] {
  return states.map((state) => {
    const score: ScoreView = scoring.scoreView(state);
    const entity = entities.get(state.entityId);
    const input: TermsPolicyInput = {
      entityId: state.entityId,
      category: state.category,
      score,
      kycTier: entity?.kycTier ?? 'none',
      repeatPairCount: pairCounts.get(state.entityId) ?? 0,
      inputs: {
        eventCount: state.eventCount,
        ...(extraInputs.get(state.entityId) ?? {}),
      },
      now,
    };
    return fees.decide(input);
  });
}
