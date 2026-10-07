/**
 * @fileoverview Recorded event weights, pair positions, rebuilds, and
 * explanations on a real store. The first test follows the worked example
 * in docs/reliability-math.md. No external API calls.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import type {
  MarketplaceTransaction, Outcome, VerificationMethod,
} from '../../packages/reliability/src/types';
import {DEFAULT_RELIABILITY_POLICIES, STUB_RELIABILITY_POLICIES} from './policies';
import {projectOutcome} from './reliability-projection';
import {createScoringRoutes} from './routes-scoring';
import {withRecordedWeights} from './score-ledger';

const NOW = '2026-10-07T00:00:00.000Z';
const LN2 = Math.log(2);

function seed(store: AgentStore): void {
  for (const id of ['buyer', 'seller', 'other']) {
    store.insertEntity({
      id, displayName: id, wallets: [], roles: ['buyer', 'seller'],
      kycStatus: 'verified', kycTier: 'basic', createdAt: NOW,
    });
  }
}

function sale(
  store: AgentStore, id: string, at: string, options: {value?: number; buyerId?: string} = {},
): MarketplaceTransaction {
  const transaction: MarketplaceTransaction = {
    id, type: 'goods',
    participants: [
      {entityId: options.buyerId ?? 'buyer', role: 'buyer'},
      {entityId: 'seller', role: 'seller'},
    ],
    terms: {item: 'cable'}, versions: [], createdAt: at,
    ...(options.value === undefined ? {} : {value: options.value}),
  };
  store.insertTransaction(transaction);
  return store.getTransaction(id)!;
}

function outcome(
  transactionId: string, at: string, state: 'successful'|'failed',
  method: VerificationMethod = 'lifecycle',
): Outcome {
  return {
    transactionId, state, evidence: {mode: 'paper'}, verificationMethod: method,
    verificationConfidence: 0.95, decidedAt: at,
    ...(state === 'failed' ? {fault: 'seller' as const} : {}),
  };
}

function state(store: AgentStore, entityId: string, role: 'buyer'|'seller') {
  return store.getReliabilityState(entityId, 'delivery', role);
}

describe('score ledger', () => {
  test('reproduces the worked example through the stored projection', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      const first = sale(store, 't1', '2026-10-01T00:00:00.000Z', {value: 1000});
      projectOutcome(store, policies, first, outcome('t1', '2026-10-01T01:00:00.000Z', 'successful'), NOW);
      expect(state(store, 'seller', 'seller')?.alpha).toBeCloseTo(1 + LN2, 12);
      expect(state(store, 'buyer', 'buyer')?.alpha).toBeCloseTo(1 + LN2, 12);
      const view = policies.scoring.scoreView(state(store, 'seller', 'seller')!);
      expect(view.value).toBeCloseTo(0.628687, 6);
      expect(view.lowerBound).toBeCloseTo(0.170448, 6);

      const second = sale(store, 't2', '2026-10-02T00:00:00.000Z', {value: 1000});
      projectOutcome(store, policies, second, outcome('t2', '2026-10-02T01:00:00.000Z', 'failed'), NOW);
      const seller = state(store, 'seller', 'seller')!;
      expect(seller.alpha).toBeCloseTo(1 + LN2, 12);
      expect(seller.beta).toBeCloseTo(1 + LN2 / 2, 12);
      expect(seller.eventCount).toBe(2);
      const after = policies.scoring.scoreView(seller);
      expect(after.value).toBeCloseTo(0.557007, 6);
      expect(after.lowerBound).toBeCloseTo(0.135821, 6);
      expect(after.confidence).toBeCloseTo(0.09418, 5);
      // The buyer was not at fault, so its state keeps only the first sale.
      expect(state(store, 'buyer', 'buyer')?.eventCount).toBe(1);

      const weight = store.getEventWeight('t2:seller:seller')!;
      expect(weight).toMatchObject({pairCount: 1, pairFactor: 0.5, eligible: true, reason: 'applied'});
      expect(weight.weight).toBeCloseTo(LN2 / 2, 12);
      expect(store.getEventWeight('t1:seller:seller')?.pairCount).toBe(0);
    } finally {
      store.close();
    }
  });

  test('reuses recorded weights, so a repeated projection changes nothing', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      const transaction = sale(store, 't1', '2026-10-01T00:00:00.000Z', {value: 500});
      const decided = outcome('t1', '2026-10-01T01:00:00.000Z', 'successful');
      projectOutcome(store, policies, transaction, decided, NOW);
      const states = store.listReliabilityStates();
      const weights = store.listEventWeightsForTransaction('t1');
      projectOutcome(store, policies, transaction, decided, '2026-10-09T00:00:00.000Z');
      expect(store.listReliabilityStates()).toEqual(states);
      expect(store.listEventWeightsForTransaction('t1')).toEqual(weights);
    } finally {
      store.close();
    }
  });

  test('records zero weight for unverified and unknown-value events and keeps pair positions free', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      const unverified = sale(store, 'u1', '2026-10-01T00:00:00.000Z', {value: 1000});
      projectOutcome(store, policies, unverified,
        outcome('u1', '2026-10-01T01:00:00.000Z', 'successful', 'unverified'), NOW);
      const unknown = sale(store, 'u2', '2026-10-02T00:00:00.000Z');
      projectOutcome(store, policies, unknown, outcome('u2', '2026-10-02T01:00:00.000Z', 'successful'), NOW);
      expect(state(store, 'seller', 'seller')).toMatchObject({alpha: 1, beta: 1, eventCount: 0});
      expect(store.getEventWeight('u1:seller:seller')).toMatchObject({weight: 0, reason: 'unverified'});
      expect(store.getEventWeight('u2:seller:seller')).toMatchObject({weight: 0, reason: 'value_missing'});

      const counted = sale(store, 'c1', '2026-10-03T00:00:00.000Z', {value: 1000});
      projectOutcome(store, policies, counted, outcome('c1', '2026-10-03T01:00:00.000Z', 'successful'), NOW);
      expect(store.getEventWeight('c1:seller:seller')?.pairCount).toBe(0);
    } finally {
      store.close();
    }
  });

  test('keeps pair counts per counterparty and category', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      projectOutcome(store, policies, sale(store, 'a1', '2026-10-01T00:00:00.000Z', {value: 1000}),
        outcome('a1', '2026-10-01T01:00:00.000Z', 'successful'), NOW);
      projectOutcome(store, policies, sale(store, 'b1', '2026-10-02T00:00:00.000Z', {value: 1000, buyerId: 'other'}),
        outcome('b1', '2026-10-02T01:00:00.000Z', 'successful'), NOW);
      expect(store.getEventWeight('b1:seller:seller')?.pairCount).toBe(0);
      expect(state(store, 'seller', 'seller')?.alpha).toBeCloseTo(1 + 2 * LN2, 12);
    } finally {
      store.close();
    }
  });

  test('moves later pair members down when a transaction loses eligibility', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      for (const [index, id] of ['p1', 'p2', 'p3'].entries()) {
        const at = `2026-10-0${index + 1}T00:00:00.000Z`;
        projectOutcome(store, policies, sale(store, id, at, {value: 1000}),
          outcome(id, at.replace('T00', 'T01'), 'successful'), NOW);
      }
      expect(state(store, 'seller', 'seller')?.alpha).toBeCloseTo(1 + LN2 * (1 + 1 / 2 + 1 / 3), 12);

      store.replaceReliabilityEvents('p1', [], NOW);
      const affected = policies.ledger.reconcilePairs('p1', [], NOW);
      expect(affected.map((key) => `${key.entityId}:${key.role}`).sort())
        .toEqual(['buyer:buyer', 'seller:seller']);
      for (const key of affected) policies.ledger.rebuildState(key);
      expect(store.getEventWeight('p2:seller:seller')).toMatchObject({pairCount: 0, pairFactor: 1});
      expect(store.getEventWeight('p3:seller:seller')).toMatchObject({pairCount: 1, pairFactor: 0.5});
      expect(state(store, 'seller', 'seller')?.alpha).toBeCloseTo(1 + LN2 * 1.5, 12);
      expect(state(store, 'seller', 'seller')?.eventCount).toBe(2);
    } finally {
      store.close();
    }
  });

  test('explains each score change without writing', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      projectOutcome(store, policies, sale(store, 't1', '2026-10-01T00:00:00.000Z', {value: 1000}),
        outcome('t1', '2026-10-01T01:00:00.000Z', 'successful'), NOW);
      projectOutcome(store, policies, sale(store, 't2', '2026-10-02T00:00:00.000Z', {value: 1000}),
        outcome('t2', '2026-10-02T01:00:00.000Z', 'failed'), NOW);
      const before = store.listReliabilityStates();
      const explained = policies.ledger.explain({entityId: 'seller', category: 'delivery', role: 'seller'}, NOW);
      expect(explained.changes).toHaveLength(2);
      expect(explained.baseline).toEqual({alpha: 1, beta: 1, source: 'prior'});
      const [first, second] = explained.changes;
      expect(first?.before.lowerBound).toBeCloseTo(0.05, 10);
      expect(first?.after.lowerBound).toBeCloseTo(0.170448, 6);
      expect(second?.weight.pairFactor).toBe(0.5);
      expect(second?.explanation).toContain('pair factor 0.5');
      expect(second?.explanation).toContain('added to beta');
      expect(explained.current.lowerBound).toBeCloseTo(0.135821, 6);
      expect(store.listReliabilityStates()).toEqual(before);
    } finally {
      store.close();
    }
  });

  test('rebuilds every score after a policy change', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const stub = withRecordedWeights(store, STUB_RELIABILITY_POLICIES);
      projectOutcome(store, stub, sale(store, 't1', '2026-10-01T00:00:00.000Z', {value: 1000}),
        outcome('t1', '2026-10-01T01:00:00.000Z', 'successful'), NOW);
      projectOutcome(store, stub, sale(store, 't2', '2026-10-02T00:00:00.000Z', {value: 1000}),
        outcome('t2', '2026-10-02T01:00:00.000Z', 'failed'), NOW);
      expect(state(store, 'seller', 'seller')).toMatchObject({alpha: 2, beta: 2});

      const weighted = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      const rebuilt = weighted.ledger.rebuildAll(NOW);
      expect(rebuilt).toHaveLength(2);
      const seller = state(store, 'seller', 'seller')!;
      expect(seller.alpha).toBeCloseTo(1 + LN2, 12);
      expect(seller.beta).toBeCloseTo(1 + LN2 / 2, 12);
      expect(store.getEventWeight('t2:seller:seller')?.scoringVersion).toBe('beta-weighted-v1');
      const decisions = store.listTermsDecisions('seller', 'delivery');
      expect(decisions[decisions.length - 1]).toMatchObject({
        policyVersion: 'fee-terms-curve-v1', inputs: {rebuild: true},
      });
    } finally {
      store.close();
    }
  });
});

describe('score explanation route', () => {
  test('returns the explanation and validates the query', async () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const policies = withRecordedWeights(store, DEFAULT_RELIABILITY_POLICIES);
      projectOutcome(store, policies, sale(store, 't1', '2026-10-01T00:00:00.000Z', {value: 1000}),
        outcome('t1', '2026-10-01T01:00:00.000Z', 'successful'), NOW);
      const [route] = createScoringRoutes(DEFAULT_RELIABILITY_POLICIES, () => NOW);
      const call = async (query: string) => {
        const url = new URL(`http://localhost/reliability/scores/explain?${query}`);
        return route!.handler(new Request(url), url, store);
      };
      const response = await call('entityId=seller&category=delivery&role=seller');
      expect(response.status).toBe(200);
      const body = await response.json() as {changes: {weight: {weight: number}}[]};
      expect(body.changes).toHaveLength(1);
      expect(body.changes[0]?.weight.weight).toBeCloseTo(LN2, 12);
      expect((await call('entityId=seller&category=delivery')).status).toBe(400);
      expect((await call('entityId=seller&category=nope&role=seller')).status).toBe(400);
    } finally {
      store.close();
    }
  });
});
