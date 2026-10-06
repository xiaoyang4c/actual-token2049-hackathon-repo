/**
 * @fileoverview Plumbing read routes for the UI lane (lane C). These
 * routes serve seed fixtures now. Lane C builds against them today.
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

/** Creates fixture handlers with the same policy seams as lifecycle handlers. */
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

  function receiptFor(transactionId: string): Receipt|undefined {
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
      handler: (request, url) => {
        const id = url.searchParams.get('id');
        if (id) {
          const entity = FIXTURE_ENTITIES.find((entry) => entry.id === id);
          if (!entity) return json({error: 'unknown entity'}, 404);
          return json(entity);
        }
        return json(FIXTURE_ENTITIES);
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
      handler: (request, url) => {
        const id = url.searchParams.get('id');
        if (id) {
          const listing = FIXTURE_LISTINGS.find((entry) => entry.id === id);
          if (!listing) return json({error: 'unknown listing'}, 404);
          return json(listing);
        }
        return json(FIXTURE_LISTINGS);
      },
    },
    {
      method: 'GET',
      path: '/reliability/transactions',
      handler: (request, url) => {
        const id = url.searchParams.get('id');
        if (id) {
          const transaction = FIXTURE_TRANSACTIONS.find(
            (entry) => entry.id === id,
          );
          if (!transaction) return json({error: 'unknown transaction'}, 404);
          return json(transaction);
        }
        return json(FIXTURE_TRANSACTIONS);
      },
    },
    {
      method: 'GET',
      path: '/reliability/receipts',
      handler: (request, url) => {
        const transactionId = url.searchParams.get('transactionId');
        if (!transactionId) {
          return json({error: 'transactionId is required'}, 400);
        }
        const receipt = receiptFor(transactionId);
        if (!receipt) return json({error: 'unknown transaction'}, 404);
        return json(receipt);
      },
    },
  ];
}

/** Default fixture routes. Existing registry imports remain available. */
export const plumbingRoutes: ReliabilityRoute[] = createPlumbingRoutes();
