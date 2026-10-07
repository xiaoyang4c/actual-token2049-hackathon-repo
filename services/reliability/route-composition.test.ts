/**
 * @fileoverview Policy injection, store isolation, and lifecycle read retries.
 */

import {describe, expect, test} from 'bun:test';
import {AgentStore} from '../../packages/db/src/index';
import type {TermsPolicyInput} from '../../packages/reliability/src/fees-policy';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
import {
  DEFAULT_RELIABILITY_POLICIES as SHIPPED_POLICIES,
  STUB_RELIABILITY_POLICIES as DEFAULT_RELIABILITY_POLICIES,
} from './policies';
import {createLaneARoutes} from './routes-lane-a';
import {createPlumbingRoutes} from './routes-plumbing';
import type {ReliabilityRoute} from './route';

const NOW = '2026-10-06T00:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';

async function request(
  routes: ReliabilityRoute[], store: AgentStore, path: string, body?: unknown,
): Promise<Response> {
  const method = body === undefined ? 'GET' : 'POST';
  const url = new URL(path, 'http://localhost');
  const route = routes.find((entry) =>
    entry.method === method && entry.path === url.pathname);
  if (!route) throw new Error(`missing route ${method} ${url.pathname}`);
  return route.handler(new Request(url, {
    method,
    ...(body === undefined ? {} : {
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(body),
    }),
  }), url, store);
}

async function openSale(
  routes: ReliabilityRoute[], store: AgentStore, value = 50,
): Promise<void> {
  const response = await request(routes, store, '/reliability/lifecycle/open', {
    id: 'sale', type: 'goods', buyerId: 'buyer', sellerId: 'seller',
    terms: {goods: 'cable'}, value, at: NOW,
  });
  expect(response.status).toBe(200);
}

async function settleSale(
  routes: ReliabilityRoute[], store: AgentStore,
): Promise<Response> {
  await openSale(routes, store);
  for (const action of [
    {
      action: 'fund', amountLovelace: 50_000_000,
      sellerReturnAddress: 'addr_test1_seller', disputeWindowEnds: WINDOW,
    },
    {
      action: 'deliver',
      evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer'},
    },
  ]) {
    const response = await request(
      routes, store, '/reliability/lifecycle/transition',
      {...action, transactionId: 'sale', at: NOW},
    );
    expect(response.status).toBe(200);
  }
  return request(routes, store, '/reliability/lifecycle/transition', {
    action: 'release', transactionId: 'sale', at: NOW,
  });
}

describe('reliability route composition', () => {
  test('uses injected scoring and fees for fixture and lifecycle responses', async () => {
    const store = AgentStore.open();
    const inputs: TermsPolicyInput[] = [];
    const defaults = DEFAULT_RELIABILITY_POLICIES;
    const policies = {
      ...defaults,
      scoring: {
        version: 'test-scoring',
        initialState: defaults.scoring.initialState.bind(defaults.scoring),
        baseWeight: defaults.scoring.baseWeight.bind(defaults.scoring),
        applyEvent: defaults.scoring.applyEvent.bind(defaults.scoring),
        scoreView: (state: Parameters<typeof defaults.scoring.scoreView>[0]) => ({
          ...defaults.scoring.scoreView(state), lowerBound: 0.25,
        }),
      },
      fees: {
        version: 'test-fees',
        decide: (input: TermsPolicyInput) => {
          inputs.push(input);
          return {
            ...defaults.fees.decide(input),
            policyVersion: 'test-fees', buyerFeeBps: 17, sellerFeeBps: 23,
          };
        },
      },
    };
    const escrowForStore = createSimulatedMasumiEscrow;
    try {
      store.insertEntity({
        id: 'buyer', displayName: 'Buyer', wallets: [], roles: ['buyer'],
        kycStatus: 'verified', kycTier: 'enhanced', createdAt: NOW,
      });
      const fixtures = createPlumbingRoutes(policies);
      const scores = await (await request(
        fixtures, store, '/reliability/scores',
      )).json() as {lowerBound: number}[];
      expect(scores.every((score) => score.lowerBound === 0.25)).toBe(true);
      const receipt = await (await request(
        fixtures, store, '/reliability/receipts?transactionId=tx-invoice-1',
      )).json() as {termsDecision: {policyVersion: string}};
      expect(receipt.termsDecision.policyVersion).toBe('test-fees');

      const routes = createLaneARoutes({policies, escrowForStore});
      const response = await settleSale(routes, store);
      expect(response.status).toBe(200);
      const view = await response.json() as {
        termsDecisions: {policyVersion: string; buyerFeeBps: number;
          sellerFeeBps: number}[];
      };
      expect(view.termsDecisions).toHaveLength(2);
      for (const decision of view.termsDecisions) {
        expect(decision.policyVersion).toBe('test-fees');
        expect(decision.buyerFeeBps).toBe(17);
        expect(decision.sellerFeeBps).toBe(23);
      }
      expect(inputs.every((input) => input.score.lowerBound === 0.25)).toBe(true);
      expect(inputs.find((input) => input.entityId === 'buyer')?.kycTier)
        .toBe('enhanced');
      expect(store.listTermsDecisions('buyer', 'delivery')[0]?.policyVersion)
        .toBe('test-fees');
      expect(store.listTermsDecisions('seller', 'delivery')[0]?.sellerFeeBps)
        .toBe(23);

      const defaultReceipt = await (await request(
        createPlumbingRoutes(), store,
        '/reliability/receipts?transactionId=tx-invoice-1',
      )).json() as {termsDecision: {policyVersion: string}};
      expect(defaultReceipt.termsDecision.policyVersion).toBe(SHIPPED_POLICIES.fees.version);
    } finally {
      store.close();
    }
  });

  test('keeps stores isolated and avoids duplicate writes after a route restart', async () => {
    const store = AgentStore.open();
    const other = AgentStore.open();
    const options = {
      escrowForStore: createSimulatedMasumiEscrow,
      clock: () => NOW,
    };
    try {
      const routes = createLaneARoutes(options);
      expect((await settleSale(routes, store)).status).toBe(200);
      expect((await request(routes, other,
        '/reliability/lifecycle?transactionId=sale')).status).toBe(404);
      await openSale(routes, other, 100);
      expect(other.getTransaction('sale')?.value).toBe(100);
      expect(store.getTransaction('sale')?.value).toBe(50);

      const path = '/reliability/lifecycle?transactionId=sale';
      const before = await (await request(routes, store, path)).json();
      const restarted = createLaneARoutes(options);
      const after = await (await request(restarted, store, path)).json();
      expect(after).toEqual(before);
      expect(store.listReliabilityEventsForTransaction('sale')).toHaveLength(2);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(1);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(1);
      expect(store.getReliabilityState('buyer', 'delivery', 'buyer')?.eventCount)
        .toBe(1);
      expect(other.listReliabilityEventsForTransaction('sale')).toHaveLength(0);
    } finally {
      store.close();
      other.close();
    }
  });
});
