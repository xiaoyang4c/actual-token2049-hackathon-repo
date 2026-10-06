/**
 * @fileoverview Plumbing read routes for the UI lane (lane C). These
 * routes serve seed fixtures now. Lane C builds against them today.
 * Lane D owns the fixtures. The math lane replaces the stub score and
 * fee calls with real implementations in its own route file.
 */

import {
  FIXTURE_ENTITIES,
  FIXTURE_LISTINGS,
  FIXTURE_OUTCOMES,
  FIXTURE_STATES,
  FIXTURE_TRANSACTIONS,
  outcomeToEvents,
  StubFeeTermsPolicy,
  StubScoringPolicy,
} from '../../packages/reliability/src/index';
import type {
  Receipt,
  ScoreView,
  TermsDecision,
} from '../../packages/reliability/src/index';
import {json} from '../lib/http';
import type {Handler} from '../lib/http';

/** One read route. Method and path join as "METHOD /path". */
export interface ReliabilityRoute {
  method: string;
  path: string;
  handler: Handler;
}

const scoring = new StubScoringPolicy();
const fees = new StubFeeTermsPolicy();

function scoreViews(entityId?: string): ScoreView[] {
  return FIXTURE_STATES.filter(
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
export const plumbingRoutes: ReliabilityRoute[] = [
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
    handler: (request, url) => json(
      scoreViews(url.searchParams.get('entityId') ?? undefined),
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
