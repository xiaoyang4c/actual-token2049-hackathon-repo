/**
 * @fileoverview Coordinates lifecycle views and writes on one shared store.
 * HTTP parsing stays in the request adapter. Policies and escrow are injected.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {
  EscrowTransactionLifecycle, LifecycleError, type LifecycleTransition,
} from '../../packages/reliability/src/lifecycle';
import type {EscrowPort} from '../../packages/reliability/src/escrow-port';
import {flowLifecycleOutcome} from '../../packages/reliability/src/lifecycle-flow';
import {createEscrowPort} from './masumi-escrow';
import {
  DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies,
} from './policies';

/** Dependencies for one store. Default escrow keeps the existing network gates. */
export interface LifecycleServiceOptions {
  policies?: ReliabilityPolicies;
  escrow?: EscrowPort;
}

/** One service per control store. The route factory owns its lifetime. */
export class LifecycleService {
  readonly lifecycle: EscrowTransactionLifecycle;
  private readonly policies: ReliabilityPolicies;

  constructor(
    private readonly store: AgentStore,
    options: LifecycleServiceOptions = {},
  ) {
    this.policies = options.policies ?? DEFAULT_RELIABILITY_POLICIES;
    this.lifecycle = new EscrowTransactionLifecycle({
      store,
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

  view(transactionId: string, now: string): {
    mode: 'paper'|'live';
    transaction: ReturnType<EscrowTransactionLifecycle['getTransaction']>;
    stage: ReturnType<EscrowTransactionLifecycle['currentStage']>;
    transitions: readonly LifecycleTransition[];
    outcome: ReturnType<EscrowTransactionLifecycle['outcomeFor']>;
    entities: ReturnType<AgentStore['listEntities']>;
    events: ReturnType<typeof flowLifecycleOutcome>['events'];
    termsDecisions: ReturnType<typeof flowLifecycleOutcome>['decisions'];
  } {
    const lifecycle = this.lifecycle;
    if (!lifecycle.hasTransaction(transactionId)) {
      throw new LifecycleError(`unknown transaction ${transactionId}`);
    }
    const transaction = lifecycle.getTransaction(transactionId);
    const outcome = lifecycle.outcomeFor(transactionId, {now});
    const entities = new Map(
      this.store.listEntities().map((entity) => [entity.id, entity]),
    );
    const flowed = flowLifecycleOutcome(
      transaction, outcome, this.policies.scoring, this.policies.decay,
      this.policies.fees, now, entities,
    );
    const existing = this.store.listReliabilityEventsForTransaction(transactionId);
    let inserted = false;
    for (const event of flowed.events) {
      if (!existing.some((item) => item.id === event.id)) {
        this.store.insertReliabilityEvent(event);
        inserted = true;
      }
    }
    if (inserted) {
      for (const state of flowed.states) this.store.saveReliabilityState(state);
      for (const decision of flowed.decisions) this.store.insertTermsDecision(decision);
    }
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
