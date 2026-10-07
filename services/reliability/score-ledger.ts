/**
 * @fileoverview Store-backed event weights for the reliability score.
 *
 * The ledger records W = a * w * D(n) for each event the first time a
 * score applies it. Later applications, reads, and rebuilds reuse that
 * record, so a read never changes a weight or a pair count.
 *
 * Pair counts: the pair key holds buyer, seller, and category. The first
 * application of an eligible transaction takes the next position in its
 * pair. Both role events of that transaction read the same position.
 * Retries and reads reuse it. A transaction that loses its eligibility
 * leaves the pair, and later transactions of that pair move down.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {
  composeEventWeight, weightInputsKey, type EventWeightRecord,
} from '../../packages/reliability/src/event-weights';
import {pairKeyFor} from '../../packages/reliability/src/pair-decay';
import type {ScoringPolicy} from '../../packages/reliability/src/scoring';
import type {
  EntityRole, ReliabilityCategory, ReliabilityEvent, ReliabilityState, ScoreView,
} from '../../packages/reliability/src/types';
import type {ReliabilityPolicies} from './policies';

/** One applied event in a score explanation. */
export interface ScoreChange {
  eventId: string;
  transactionId: string;
  outcome: ReliabilityEvent['outcome'];
  createdAt: string;
  weight: EventWeightRecord;
  /** False when the event has no recorded weight yet. */
  recorded: boolean;
  before: Pick<ScoreView, 'value'|'lowerBound'|'confidence'> & {alpha: number; beta: number};
  after: Pick<ScoreView, 'value'|'lowerBound'|'confidence'> & {alpha: number; beta: number};
  explanation: string;
}

/** Score history for one entity, category, and role. */
export interface ScoreExplanation {
  entityId: string;
  category: ReliabilityCategory;
  role: EntityRole;
  scoringVersion: string;
  decayVersion: string;
  baseline: {alpha: number; beta: number; source: 'stored_baseline'|'prior'};
  changes: ScoreChange[];
  current: ScoreView;
}

type StateKey = {entityId: string; category: ReliabilityCategory; role: EntityRole};

function byTimeThenId(left: ReliabilityEvent, right: ReliabilityEvent): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id);
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** Event weights, pair positions, rebuilds, and explanations on one store. */
export class ScoreLedger {
  constructor(
    private readonly store: AgentStore,
    readonly policies: ReliabilityPolicies,
  ) {}

  /** Recorded weight for one event. Records it on first use. Run inside a store transaction. */
  weightFor(event: ReliabilityEvent, at: string): EventWeightRecord {
    const {scoring, decay} = this.policies;
    const stored = this.store.getEventWeight(event.id);
    if (stored && stored.inputsKey === weightInputsKey(event, scoring, decay)) return stored;
    const pairKey = this.pairKey(event);
    let count = 0;
    if (pairKey) {
      const eligible = scoring.baseWeight(event).weight > 0;
      const position = eligible ?
        this.store.addPairTransaction(pairKey, event.transactionId, at) :
        this.store.getPairPosition(pairKey, event.transactionId);
      count = position ?? 0;
    }
    const record = composeEventWeight(event, scoring, decay, {key: pairKey, count}, at);
    this.store.saveEventWeight(record);
    return record;
  }

  /** Weight without a write. Explanations use it for events with no record. */
  previewWeight(event: ReliabilityEvent): {weight: EventWeightRecord; recorded: boolean} {
    const {scoring, decay} = this.policies;
    const stored = this.store.getEventWeight(event.id);
    if (stored && stored.inputsKey === weightInputsKey(event, scoring, decay)) {
      return {weight: stored, recorded: true};
    }
    const pairKey = this.pairKey(event);
    const count = pairKey ? this.store.getPairPosition(pairKey, event.transactionId) ?? 0 : 0;
    return {
      weight: composeEventWeight(event, scoring, decay, {key: pairKey, count}, event.createdAt),
      recorded: false,
    };
  }

  /**
   * Updates pair membership after a transaction's active events change.
   * A transaction with no positive base weight leaves its pairs. Returns
   * the states whose weights changed because later pair positions moved.
   */
  reconcilePairs(transactionId: string, active: readonly ReliabilityEvent[], at: string): StateKey[] {
    if (active.some((event) => this.policies.scoring.baseWeight(event).weight > 0)) return [];
    const moved = this.store.removePairTransaction(transactionId);
    const affected = new Map<string, StateKey>();
    for (const movedId of moved) {
      for (const event of this.store.listReliabilityEventsForTransaction(movedId)) {
        const pairKey = this.pairKey(event);
        const position = pairKey ? this.store.getPairPosition(pairKey, movedId) : undefined;
        const record = composeEventWeight(
          event, this.policies.scoring, this.policies.decay,
          {key: pairKey, count: position ?? 0}, at,
        );
        this.store.saveEventWeight(record);
        affected.set(JSON.stringify([event.entityId, event.category, event.role]), {
          entityId: event.entityId, category: event.category, role: event.role,
        });
      }
    }
    return [...affected.values()];
  }

  /**
   * Rebuilds one state from its stored baseline, or the prior, and its
   * active events with their recorded weights. Saves and returns it.
   */
  rebuildState(key: StateKey): ReliabilityState|undefined {
    const {scoring} = this.policies;
    const recorded = this.store.listReliabilityEventsForState(key.entityId, key.category, key.role)
      .sort(byTimeThenId);
    const first = recorded[0];
    const baseline = this.store.getReliabilityBaseline(key.entityId, key.category, key.role) ??
      (first ? scoring.initialState(key.entityId, key.category, key.role, first.createdAt) : undefined);
    if (!baseline) return undefined;
    const state = recorded.reduce((current, item) =>
      scoring.applyEvent(current, item, item.createdAt, this.weightFor(item, item.createdAt).weight), baseline);
    this.store.saveReliabilityState(state);
    return state;
  }

  /**
   * Recomputes every weight and pair position in event order, then
   * rebuilds every state with active events. Use it after a policy change.
   * A state without a stored baseline restarts from the prior.
   */
  rebuildAll(at: string): ReliabilityState[] {
    return this.store.transaction(() => {
      this.store.clearScoreWeights();
      const events = this.store.listTransactions()
        .flatMap((transaction) => this.store.listReliabilityEventsForTransaction(transaction.id))
        .sort(byTimeThenId);
      const keys = new Map<string, StateKey>();
      for (const event of events) {
        this.weightFor(event, event.createdAt);
        keys.set(JSON.stringify([event.entityId, event.category, event.role]), {
          entityId: event.entityId, category: event.category, role: event.role,
        });
      }
      const rebuilt: ReliabilityState[] = [];
      for (const key of keys.values()) {
        const state = this.rebuildState(key);
        if (!state) continue;
        rebuilt.push(state);
        const entity = this.store.getEntity(key.entityId);
        this.store.insertTermsDecision(this.policies.fees.decide({
          entityId: key.entityId, category: key.category,
          score: this.policies.scoring.scoreView(state),
          kycTier: entity?.kycTier ?? 'none', repeatPairCount: 0,
          inputs: {eventCount: state.eventCount, rebuild: true}, now: at,
        }));
      }
      return rebuilt;
    });
  }

  /** Explains every applied event of one state. Reads only. */
  explain(key: StateKey, now: string): ScoreExplanation {
    const {scoring, decay} = this.policies;
    const recorded = this.store.listReliabilityEventsForState(key.entityId, key.category, key.role)
      .sort(byTimeThenId);
    const stored = this.store.getReliabilityBaseline(key.entityId, key.category, key.role);
    const prior = scoring.initialState(key.entityId, key.category, key.role, now);
    let state = stored ?? prior;
    const changes: ScoreChange[] = [];
    for (const event of recorded) {
      const {weight, recorded: isRecorded} = this.previewWeight(event);
      const beforeView = scoring.scoreView(state);
      const next = scoring.applyEvent(state, event, event.createdAt, weight.weight);
      const afterView = scoring.scoreView(next);
      changes.push({
        eventId: event.id, transactionId: event.transactionId, outcome: event.outcome,
        createdAt: event.createdAt, weight, recorded: isRecorded,
        before: {alpha: state.alpha, beta: state.beta, value: beforeView.value,
          lowerBound: beforeView.lowerBound, confidence: beforeView.confidence},
        after: {alpha: next.alpha, beta: next.beta, value: afterView.value,
          lowerBound: afterView.lowerBound, confidence: afterView.confidence},
        explanation: describeChange(event, weight, beforeView, afterView),
      });
      state = next;
    }
    return {
      ...key,
      scoringVersion: scoring.version,
      decayVersion: decay.version,
      baseline: stored ?
        {alpha: stored.alpha, beta: stored.beta, source: 'stored_baseline'} :
        {alpha: prior.alpha, beta: prior.beta, source: 'prior'},
      changes,
      current: scoring.scoreView(state),
    };
  }

  private pairKey(event: ReliabilityEvent): string|null {
    const transaction = this.store.getTransaction(event.transactionId);
    const buyer = transaction?.participants.find((party) => party.role === 'buyer');
    const seller = transaction?.participants.find((party) => party.role === 'seller');
    if (!buyer || !seller) return null;
    return pairKeyFor(buyer.entityId, seller.entityId, event.category, this.policies.decay.direction);
  }
}

function describeChange(
  event: ReliabilityEvent, weight: EventWeightRecord, before: ScoreView, after: ScoreView,
): string {
  const parts = [`${event.role} ${event.outcome} on ${event.transactionId}`];
  if (weight.reason === 'unverified') parts.push('unverified evidence carries no weight');
  else if (weight.reason === 'value_missing') parts.push('the value is unknown, so the event carries no weight');
  else if (weight.reason === 'value_zero') parts.push('a zero value carries no weight');
  else {
    parts.push(`value ${weight.normalizedValue} with scale ${weight.valueScale} gives value weight ${round(weight.valueWeight)}`);
    if (weight.pairCount > 0) {
      parts.push(`${weight.pairCount} earlier sale(s) with this counterparty give pair factor ${round(weight.pairFactor)}`);
    }
    parts.push(`weight ${round(weight.weight)} added to ${event.outcome === 'success' ? 'alpha' : 'beta'}`);
  }
  parts.push(`lower bound ${round(before.lowerBound, 4)} -> ${round(after.lowerBound, 4)}`);
  return parts.join('; ');
}

/**
 * Wraps a policy bundle so every applied event uses its recorded weight.
 * The wrapper ignores a weight that the caller passes.
 */
export function withRecordedWeights(
  store: AgentStore, policies: ReliabilityPolicies,
): ReliabilityPolicies & {ledger: ScoreLedger} {
  const ledger = new ScoreLedger(store, policies);
  const inner = policies.scoring;
  const scoring: ScoringPolicy = {
    version: inner.version,
    initialState: (entityId, category, role, now) => inner.initialState(entityId, category, role, now),
    baseWeight: (event) => inner.baseWeight(event),
    applyEvent: (state, event, now) => inner.applyEvent(state, event, now, ledger.weightFor(event, now).weight),
    scoreView: (state) => inner.scoreView(state),
  };
  return {...policies, scoring, ledger};
}
