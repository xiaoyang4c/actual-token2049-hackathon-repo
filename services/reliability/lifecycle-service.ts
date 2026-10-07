/**
 * @fileoverview Coordinates lifecycle views and writes on one shared store.
 * HTTP parsing stays in the request adapter. Policies and escrow are injected.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {
  EscrowTransactionLifecycle, LifecycleError, type LifecycleTransition,
  type OpenTransactionInput,
} from '../../packages/reliability/src/lifecycle';
import type {FeeCharge} from '../../packages/reliability/src/fee-charges';
import type {
  JsonValue, Listing, MarketplaceTransaction, TermsVersion,
} from '../../packages/reliability/src/types';
import type {EscrowPort} from '../../packages/reliability/src/escrow-port';
import {STUB_SCORING_VERSION} from '../../packages/reliability/src/scoring';
import {outcomeToEvents} from '../../packages/reliability/src/event-flow';
import {flowLifecycleOutcome} from '../../packages/reliability/src/lifecycle-flow';
import {
  FeeBook, MarketplaceGate, platformFeeTerms, reliabilityTerms, type DealCheck,
} from './marketplace-gate';
import {createEscrowPort} from './masumi-escrow';
import {
  DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies,
} from './policies';
import {withRecordedWeights, type ScoreLedger} from './score-ledger';

/** Dependencies for one store. Default escrow keeps the existing network gates. */
export interface LifecycleServiceOptions {
  policies?: ReliabilityPolicies;
  escrow?: EscrowPort;
  clock?: () => string;
  /**
   * Check KYC, exposure limits, and invoice payment days before a sale
   * opens, and record the accepted fees. Defaults to true.
   */
  enforceMarketplaceRules?: boolean;
}

/** Terms keys that the service fixes when a sale opens. */
const FIXED_TERMS = ['platformFees', 'reliabilityTerms'] as const;

/** One service per control store. The route factory owns its lifetime. */
export class LifecycleService {
  readonly lifecycle: EscrowTransactionLifecycle;
  /** Recorded event weights and score rebuilds for this store. */
  readonly ledger: ScoreLedger;
  readonly policies: ReliabilityPolicies;
  /** KYC, limit, and listing checks before a sale opens. */
  readonly gate: MarketplaceGate;
  /** Accepted buyer and seller fees. */
  readonly fees: FeeBook;
  private readonly enforce: boolean;

  constructor(
    private readonly store: AgentStore,
    options: LifecycleServiceOptions = {},
  ) {
    const policies = withRecordedWeights(store, options.policies ?? DEFAULT_RELIABILITY_POLICIES);
    this.policies = policies;
    this.ledger = policies.ledger;
    this.gate = new MarketplaceGate(store, policies);
    this.fees = new FeeBook(store);
    this.enforce = options.enforceMarketplaceRules ?? true;
    this.lifecycle = new EscrowTransactionLifecycle({
      store,
      clock: options.clock,
      escrow: options.escrow ?? createEscrowPort({store, env: process.env}),
    });
  }

  ensureParty(id: string, at: string): void {
    if (this.store.getEntity(id)) return;
    this.store.insertEntity({
      id,
      displayName: id,
      wallets: [],
      kycStatus: 'unverified',
      kycTier: 'none',
      roles: ['buyer', 'seller'],
      createdAt: at,
    });
  }

  /**
   * Opens a sale after the marketplace checks. The agreed terms record the
   * accepted fees and both parties' score-based terms. With enforcement
   * off, unknown parties are created unverified, as in the original demo.
   */
  openTransaction(input: OpenTransactionInput & {listing?: Listing}): {
    transaction: MarketplaceTransaction;
    check: DealCheck|null;
    feeCharge: FeeCharge|null;
  } {
    const {listing, ...open} = input;
    return this.store.transaction(() => {
      if (!this.enforce) {
        this.ensureParty(open.buyerId, open.at);
        this.ensureParty(open.sellerId, open.at);
        return {transaction: this.lifecycle.open(open), check: null, feeCharge: null};
      }
      if (this.lifecycle.hasTransaction(open.id)) {
        throw new LifecycleError(`transaction ${open.id} already exists`);
      }
      const currency = typeof open.terms.currency === 'string' ? open.terms.currency : undefined;
      const check = this.gate.assertDeal({
        type: open.type, buyerId: open.buyerId, sellerId: open.sellerId, value: open.value,
        currency, terms: open.terms, listing, now: open.at,
      });
      const feeCharge = this.fees.quote(check, open.id, open.at);
      const terms: {[key: string]: JsonValue} = {
        ...open.terms,
        platformFees: platformFeeTerms(feeCharge),
        reliabilityTerms: reliabilityTerms(check),
      };
      const transaction = this.lifecycle.open({...open, terms});
      this.fees.accept(feeCharge);
      return {transaction, check, feeCharge};
    });
  }

  /**
   * Records a new terms version. The fee and score-based terms fixed at
   * open carry over. A request that changes them is refused. An invoice
   * due date must stay inside the buyer's payment days.
   */
  amendTerms(
    transactionId: string, terms: {[key: string]: JsonValue}, reason: string, at: string,
  ): TermsVersion {
    const current = this.lifecycle.getTransaction(transactionId);
    const next: {[key: string]: JsonValue} = {...terms};
    for (const key of FIXED_TERMS) {
      const fixed = current.terms[key];
      if (fixed === undefined) continue;
      if (next[key] !== undefined && JSON.stringify(next[key]) !== JSON.stringify(fixed)) {
        throw new LifecycleError(`${key} are fixed when the sale opens`);
      }
      next[key] = fixed;
    }
    if (this.enforce && current.type === 'invoice' && next.dueDate !== current.terms.dueDate) {
      const buyer = current.participants.find((party) => party.role === 'buyer');
      if (buyer) {
        const violations = this.gate.invoiceTermsViolations(buyer.entityId, next, current.createdAt);
        if (violations.length > 0) throw new LifecycleError(violations.map((item) => item.message).join('; '));
      }
    }
    return this.lifecycle.amendTerms(transactionId, next, reason, at);
  }

  view(transactionId: string, now: string): {
    mode: 'paper'|'live';
    transaction: ReturnType<EscrowTransactionLifecycle['getTransaction']>;
    stage: ReturnType<EscrowTransactionLifecycle['currentStage']>;
    transitions: readonly LifecycleTransition[];
    outcome: ReturnType<EscrowTransactionLifecycle['outcomeFor']>;
    entities: ReturnType<AgentStore['listEntities']>;
    events: ReturnType<typeof flowLifecycleOutcome>['events'];
    termsDecisions: ReturnType<typeof flowLifecycleOutcome>['decisions'];
    feeCharge: FeeCharge|null;
  } {
    const lifecycle = this.lifecycle;
    if (!lifecycle.hasTransaction(transactionId)) {
      throw new LifecycleError(`unknown transaction ${transactionId}`);
    }
    const transaction = lifecycle.getTransaction(transactionId);
    // Hold the write lock while reading history and committing the projection.
    // This synchronous work uses local records and injected policies only.
    const {outcome, flowed, feeCharge} = this.store.transaction(() => {
      const outcome = lifecycle.outcomeFor(transactionId, {now});
      const feeCharge = this.fees.settle(transactionId, outcome, 'lifecycle') ?? null;
      const entities = new Map(
        this.store.listEntities().map((entity) => [entity.id, entity]),
      );
      const desired = outcomeToEvents(transaction, outcome);
      const previous = this.store.listReliabilityEventsForTransaction(transactionId);
      const wanted = new Map(desired.map((event) => [event.id, event]));
      const affected = new Map([...previous, ...desired].map((event) => [
        JSON.stringify([event.entityId, event.category, event.role]), event,
      ]));
      // Preserve imported starting scores separately from replayable event history.
      for (const event of affected.values()) {
        if (this.store.getReliabilityBaseline(event.entityId, event.category, event.role)) continue;
        const recorded = this.store.listReliabilityEventsForState(event.entityId, event.category, event.role);
        let baseline = recorded.length === 0 ?
          this.store.getReliabilityState(event.entityId, event.category, event.role) : undefined;
        const existing = this.store.getReliabilityState(event.entityId, event.category, event.role);
        if (recorded.length && existing && this.policies.scoring.version === STUB_SCORING_VERSION) {
          baseline = {...existing,
            alpha: existing.alpha - recorded.filter((item) => item.outcome === 'success').length,
            beta: existing.beta - recorded.filter((item) => item.outcome === 'failure').length,
            eventCount: existing.eventCount - recorded.length,
          };
          if (baseline.alpha < 1 || baseline.beta < 1 || baseline.eventCount < 0) {
            throw new LifecycleError('legacy score history needs repair before rebuilding');
          }
        }
        this.store.saveReliabilityBaseline(baseline ?? this.policies.scoring.initialState(
          event.entityId, event.category, event.role, transaction.createdAt,
        ));
      }
      const corrected = previous.some((event) =>
        JSON.stringify(event) !== JSON.stringify(wanted.get(event.id)));
      const recoveredEventIds = new Set<string>();
      if (corrected) {
        this.store.replaceReliabilityEvents(transactionId, desired, outcome.decidedAt);
        // A transaction that lost its eligibility leaves its pairs. Later
        // pair members move down, so their states rebuild too.
        for (const key of this.ledger.reconcilePairs(transactionId, desired, outcome.decidedAt)) {
          const state = this.ledger.rebuildState(key);
          if (!state) continue;
          this.store.insertTermsDecision(this.policies.fees.decide({
            entityId: key.entityId, category: key.category,
            score: this.policies.scoring.scoreView(state),
            kycTier: entities.get(key.entityId)?.kycTier ?? 'none',
            repeatPairCount: 0, inputs: {eventCount: state.eventCount, pairRebuild: true}, now,
          }));
        }
        for (const event of affected.values()) {
          const baseline = this.store.getReliabilityBaseline(event.entityId, event.category, event.role)!;
          const recorded = this.store.listReliabilityEventsForState(
            event.entityId, event.category, event.role,
          ).sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
            left.id.localeCompare(right.id));
          const state = recorded.reduce((current, item) =>
            this.policies.scoring.applyEvent(current, item, item.createdAt), baseline);
          this.store.saveReliabilityState(state);
          recoveredEventIds.add(event.id);
          if (!wanted.has(event.id)) {
            this.store.insertTermsDecision(this.policies.fees.decide({
              entityId: event.entityId, category: event.category,
              score: this.policies.scoring.scoreView(state),
              kycTier: entities.get(event.entityId)?.kycTier ?? 'none',
              repeatPairCount: 0, inputs: {eventCount: state.eventCount}, now,
            }));
          }
        }
      }
      const states = outcomeToEvents(transaction, outcome).flatMap((event) => {
        const state = this.store.getReliabilityState(
          event.entityId, event.category, event.role,
        );
        if (state) return [state];
        // Older writes could leave event rows without a posterior. Rebuild
        // only missing triples; existing scores remain the starting history.
        const recorded = this.store.listReliabilityEventsForState(
          event.entityId, event.category, event.role,
        ).sort((left, right) =>
          Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
          left.id.localeCompare(right.id));
        const first = recorded[0];
        if (!first) return [];
        const initial = this.policies.scoring.initialState(
          event.entityId, event.category, event.role, first.createdAt,
        );
        const recovered = recorded.reduce((previous, item) =>
          this.policies.scoring.applyEvent(previous, item, item.createdAt), initial);
        recoveredEventIds.add(event.id);
        return [recovered];
      });
      const appliedEventIds = new Set(
        this.store.listReliabilityEventsForTransaction(transactionId)
          .map((event) => event.id),
      );
      const flowed = flowLifecycleOutcome(
        transaction, outcome, this.policies.scoring, this.policies.decay,
        this.policies.fees, now, entities, {states, appliedEventIds},
      );
      for (let index = 0; index < flowed.events.length; index++) {
        const event = flowed.events[index];
        if (!event) continue;
        const applied = appliedEventIds.has(event.id);
        if (applied && !recoveredEventIds.has(event.id)) continue;
        const state = flowed.states[index];
        const decision = flowed.decisions[index];
        if (!state || !decision) throw new Error('incomplete reliability projection');
        if (!applied) this.store.insertReliabilityEvent(event);
        this.store.saveReliabilityState(state);
        this.store.insertTermsDecision(decision);
      }
      return {outcome, flowed, feeCharge};
    });
    const parties = transaction.participants.flatMap((participant) => {
      const entity = this.store.getEntity(participant.entityId);
      return entity ? [entity] : [];
    });
    return {
      mode: outcome.evidence.mode === 'live' ? 'live' : 'paper',
      transaction,
      stage: lifecycle.currentStage(transactionId),
      transitions: lifecycle.listTransitions(transactionId),
      outcome,
      entities: parties,
      events: flowed.events,
      termsDecisions: flowed.decisions,
      feeCharge,
    };
  }

  latestAt(transactionId: string): string {
    const lifecycle = this.lifecycle;
    const transitions = lifecycle.listTransitions(transactionId);
    const last = transitions[transitions.length - 1];
    if (!last) throw new LifecycleError(`unknown transaction ${transactionId}`);
    return last.at;
  }
}
