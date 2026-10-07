/**
 * @fileoverview Plumbing read routes for the UI lane (lane C). These
 * routes merge stored records over seed fixtures by record ID.
 * Lane D owns the fixtures. Scoring and fees use the shared policy
 * composition seam so later implementations do not change handlers.
 */

import {
  FIXTURE_ENTITIES,
  FIXTURE_LISTINGS,
  FIXTURE_OUTCOMES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  outcomeToEvents,
} from '../../packages/reliability/src/index';
import type {AgentStore} from '../../packages/db/src/index';
import type {
  Receipt,
  ScoreView,
  TermsDecision,
} from '../../packages/reliability/src/index';
import {json} from '../lib/http';
import {DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies} from './policies';
import type {ReliabilityRoute} from './route';

// Keep the existing lane import path available.
export type {ReliabilityRoute} from './route';

/** Creates read handlers with the same policy seams as lifecycle handlers. */
export function createPlumbingRoutes(
  policies: ReliabilityPolicies = DEFAULT_RELIABILITY_POLICIES,
): ReliabilityRoute[] {
  const {scoring, fees} = policies;

  function scoreViews(entityId?: string, store?: AgentStore): ScoreView[] {
    const states = new Map(FIXTURE_STATES.map((state) => [
      JSON.stringify([state.entityId, state.category, state.role]), state,
    ]));
    for (const state of store?.listReliabilityStates() ?? []) {
      states.set(JSON.stringify([state.entityId, state.category, state.role]), state);
    }
    return [...states.values()].filter(
      (state) => !entityId || state.entityId === entityId,
    ).map((state) => scoring.scoreView(state));
  }

  function stubDecisions(entityId: string, now: string): TermsDecision[] {
    return FIXTURE_STATES.filter((state) => state.entityId === entityId).map(
      (state) => fees.decide({
        entityId: state.entityId,
        category: state.category,
        score: scoring.scoreView(state),
        kycTier: FIXTURE_ENTITIES.find(
          (entity) => entity.id === state.entityId,
        )?.kycTier ?? 'none',
        repeatPairCount: 0,
        inputs: {eventCount: state.eventCount, stub: true},
        now,
      }),
    );
  }

  function receiptFor(transactionId: string, store?: AgentStore): Receipt|undefined {
    const stored = store?.getTransaction(transactionId);
    if (stored && store) {
      const outcome = store.getOutcome(transactionId);
      const events = store.listReliabilityEventsForTransaction(transactionId);
      const seller = stored.participants.find((party) => party.role === 'seller');
      const category = stored.type === 'goods' ? 'delivery' : stored.type === 'invoice' ? 'payment' : 'fulfillment';
      const decisions = seller ? store.listTermsDecisions(seller.entityId, category) : [];
      return {transaction: stored, outcome, events, termsDecision: decisions[decisions.length - 1]};
    }
    const transaction = FIXTURE_TRANSACTIONS.find(
      (entry) => entry.id === transactionId,
    );
    if (!transaction) return undefined;
    const outcome = FIXTURE_OUTCOMES.find(
      (entry) => entry.transactionId === transactionId,
    );
    const events = outcome ? outcomeToEvents(transaction, outcome) : [];
    const seller = transaction.participants.find(
      (participant) => participant.role === 'seller',
    );
    const termsDecision = seller ?
      stubDecisions(seller.entityId, outcome?.decidedAt ?? transaction.createdAt)
        .find((decision) => decision.category === events[0]?.category) :
      undefined;
    return {transaction, outcome, events, termsDecision};
  }

  /** Plumbing routes. Later lanes add their own files, not edits here. */
  return [
    {
      method: 'GET',
      path: '/reliability/entities',
      handler: (request, url, store) => {
        const entities = new Map(FIXTURE_ENTITIES.map((entry) => [entry.id, entry]));
        for (const entity of store?.listEntities() ?? []) entities.set(entity.id, entity);
        const id = url.searchParams.get('id');
        if (id) {
          const entity = entities.get(id);
          if (!entity) return json({error: 'unknown entity'}, 404);
          return json(entity);
        }
        return json([...entities.values()]);
      },
    },
    {
      method: 'GET',
      path: '/reliability/scores',
      handler: (request, url, store) => json(
        scoreViews(url.searchParams.get('entityId') ?? undefined, store),
      ),
    },
    {
      method: 'GET',
      path: '/reliability/listings',
      handler: (request, url, store) => {
        const listings = new Map(FIXTURE_LISTINGS.map((entry) => [entry.id, entry]));
        for (const listing of store?.listListings() ?? []) listings.set(listing.id, listing);
        const id = url.searchParams.get('id');
        if (id) {
          const listing = listings.get(id);
          if (!listing) return json({error: 'unknown listing'}, 404);
          return json(listing);
        }
        return json([...listings.values()]);
      },
    },
    {
      method: 'GET',
      path: '/reliability/transactions',
      handler: (request, url, store) => {
        const transactions = new Map(FIXTURE_TRANSACTIONS.map((entry) => [entry.id, entry]));
        for (const transaction of store?.listTransactions() ?? []) transactions.set(transaction.id, transaction);
        const id = url.searchParams.get('id');
        if (id) {
          const transaction = transactions.get(id);
          if (!transaction) return json({error: 'unknown transaction'}, 404);
          return json(transaction);
        }
        return json([...transactions.values()]);
      },
    },
    {
      method: 'GET',
      path: '/reliability/receipts',
      handler: (request, url, store) => {
        const transactionId = url.searchParams.get('transactionId');
        if (!transactionId) {
          return json({error: 'transactionId is required'}, 400);
        }
        const receipt = receiptFor(transactionId, store);
        if (!receipt) return json({error: 'unknown transaction'}, 404);
        return json(receipt);
      },
    },
  ];
}

/** Default read routes. Existing registry imports remain available. */
export const plumbingRoutes: ReliabilityRoute[] = createPlumbingRoutes();
