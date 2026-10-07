/**
 * @fileoverview Cumulative, atomic reliability projections over local history.
 * Escrow is explicitly simulated. These tests do not call external APIs.
 */

import {describe, expect, spyOn, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {outcomeToEvents} from '../../packages/reliability/src/event-flow';
import {flowLifecycleOutcome} from '../../packages/reliability/src/lifecycle-flow';
import type {ScoreView, TransactionType} from '../../packages/reliability/src/types';
import {LifecycleService} from './lifecycle-service';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
// These tests pin cumulative mechanics with unit weights.
import {STUB_RELIABILITY_POLICIES as DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies} from './policies';
import {createPlumbingRoutes} from './routes-plumbing';

const NOW = '2026-10-06T00:00:00.000Z';
const WINDOW = '2026-10-13T00:00:00.000Z';

function serviceFor(
  store: AgentStore, policies: ReliabilityPolicies = DEFAULT_RELIABILITY_POLICIES,
): LifecycleService {
  return new LifecycleService(store, {
    policies, escrow: createSimulatedMasumiEscrow(store),
  });
}

function open(
  service: LifecycleService, id: string, options: {
    buyerId?: string; sellerId?: string; type?: TransactionType;
  } = {},
): void {
  const buyerId = options.buyerId ?? 'buyer';
  const sellerId = options.sellerId ?? 'seller';
  service.ensureParty(buyerId, NOW);
  service.ensureParty(sellerId, NOW);
  service.lifecycle.open({
    id, type: options.type ?? 'goods', buyerId, sellerId,
    terms: {item: 'cable'}, value: 50, at: NOW,
  });
}

async function fund(service: LifecycleService, id: string): Promise<void> {
  await service.lifecycle.fund({
    transactionId: id, amountLovelace: 50_000_000,
    sellerReturnAddress: 'addr_test1_seller', disputeWindowEnds: WINDOW, at: NOW,
  });
}

async function settle(
  service: LifecycleService, id: string, options: {
    buyerId?: string; sellerId?: string; type?: TransactionType;
  } = {},
): Promise<void> {
  open(service, id, options);
  await fund(service, id);
  service.lifecycle.confirmDelivery({
    transactionId: id, at: NOW,
    evidence: {
      deliveryTier: 'buyer_confirmation', confirmedBy: options.buyerId ?? 'buyer',
    },
  });
  await service.lifecycle.release({transactionId: id, at: NOW});
}

describe('cumulative lifecycle scoring', () => {
  test('accumulates outcomes and exposes current scores without replaying old events', async () => {
    const store = AgentStore.open();
    const defaults = DEFAULT_RELIABILITY_POLICIES;
    let applied = 0;
    const policies = {
      ...defaults,
      scoring: {
        version: defaults.scoring.version,
        initialState: defaults.scoring.initialState.bind(defaults.scoring),
        baseWeight: defaults.scoring.baseWeight.bind(defaults.scoring),
        scoreView: defaults.scoring.scoreView.bind(defaults.scoring),
        applyEvent: (...args: Parameters<typeof defaults.scoring.applyEvent>) => {
          applied++;
          return defaults.scoring.applyEvent(...args);
        },
      },
    };
    try {
      const service = serviceFor(store, policies);
      await settle(service, 'first');
      service.view('first', NOW);
      await settle(service, 'second');
      const current = service.view('second', NOW);
      expect(current.termsDecisions.map((decision) => decision.inputs.eventCount))
        .toEqual([2, 2]);
      const states = store.listReliabilityStates();
      expect(states).toHaveLength(2);
      for (const state of states) {
        expect(state).toMatchObject({alpha: 3, beta: 1, eventCount: 2});
      }
      const previous = service.view('first', NOW);
      expect(previous.termsDecisions.map((decision) => decision.inputs.eventCount))
        .toEqual([2, 2]);
      expect(service.view('first', NOW)).toEqual(previous);
      expect(store.listReliabilityStates()).toEqual(states);
      expect(store.listReliabilityEventsForTransaction('first')).toHaveLength(2);
      expect(store.listReliabilityEventsForTransaction('second')).toHaveLength(2);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(2);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(2);
      expect(applied).toBe(4);

      const url = new URL('http://localhost/reliability/scores?entityId=buyer');
      const route = createPlumbingRoutes(policies).find((entry) => entry.path === url.pathname);
      if (!route) throw new Error('missing scores route');
      const response = await route.handler(new Request(url), url, store);
      expect(await response.json()).toEqual([
        defaults.scoring.scoreView(states.find((state) => state.entityId === 'buyer')!),
      ]);
    } finally {
      store.close();
    }
  });

  test('continues an existing posterior and isolates roles and categories', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      service.ensureParty('buyer', NOW);
      store.saveReliabilityState({
        entityId: 'buyer', category: 'delivery', role: 'buyer',
        alpha: 10, beta: 4, eventCount: 12, updatedAt: NOW,
      });
      await settle(service, 'goods');
      service.view('goods', NOW);
      await settle(service, 'reverse', {buyerId: 'seller', sellerId: 'buyer'});
      service.view('reverse', NOW);
      await settle(service, 'service', {type: 'service'});
      service.view('service', NOW);

      expect(store.getReliabilityState('buyer', 'delivery', 'buyer'))
        .toMatchObject({alpha: 11, beta: 4, eventCount: 13});
      expect(store.getReliabilityState('buyer', 'delivery', 'seller'))
        .toMatchObject({alpha: 2, beta: 1, eventCount: 1});
      expect(store.getReliabilityState('buyer', 'fulfillment', 'buyer'))
        .toMatchObject({alpha: 2, beta: 1, eventCount: 1});
      expect(store.getReliabilityState('buyer', 'fulfillment', 'seller')).toBeUndefined();
      expect(store.getReliabilityState('seller', 'delivery', 'seller'))
        .toMatchObject({alpha: 2, beta: 1, eventCount: 1});
    } finally {
      store.close();
    }
  });

  test('adds a failure only to the at-fault role', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      await settle(service, 'success');
      service.view('success', NOW);
      open(service, 'buyer-failure');
      await fund(service, 'buyer-failure');
      await service.lifecycle.refund({transactionId: 'buyer-failure', fault: 'buyer', at: NOW});
      expect(service.view('buyer-failure', NOW).events.map((event) => event.role))
        .toEqual(['buyer']);
      expect(store.getReliabilityState('buyer', 'delivery', 'buyer'))
        .toMatchObject({alpha: 2, beta: 2, eventCount: 2});
      expect(store.getReliabilityState('seller', 'delivery', 'seller'))
        .toMatchObject({alpha: 2, beta: 1, eventCount: 1});

      open(service, 'seller-failure');
      await fund(service, 'seller-failure');
      service.lifecycle.openDispute({
        transactionId: 'seller-failure', resolver: 'reviewer', resolveBy: WINDOW, at: NOW,
      });
      await service.lifecycle.resolveDispute({
        transactionId: 'seller-failure', resolver: 'reviewer', decision: 'uphold_buyer', at: NOW,
      });
      expect(service.view('seller-failure', NOW).events.map((event) => event.role))
        .toEqual(['seller']);
      expect(store.getReliabilityState('seller', 'delivery', 'seller'))
        .toMatchObject({alpha: 2, beta: 2, eventCount: 2});
      expect(store.getReliabilityState('buyer', 'delivery', 'buyer'))
        .toMatchObject({alpha: 2, beta: 2, eventCount: 2});
    } finally {
      store.close();
    }
  });

  test('keeps pending, disputed, unresolved, and cancelled outcomes out of scores', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      await settle(service, 'baseline');
      service.view('baseline', NOW);
      const states = store.listReliabilityStates();
      open(service, 'inactive');
      expect(service.view('inactive', NOW).events).toHaveLength(0);
      await fund(service, 'inactive');
      expect(service.view('inactive', NOW).events).toHaveLength(0);
      service.lifecycle.openDispute({
        transactionId: 'inactive', resolver: 'reviewer', resolveBy: WINDOW, at: NOW,
      });
      expect(service.view('inactive', NOW).outcome.state).toBe('disputed');
      expect(service.view('inactive', '2026-10-14T00:00:00.000Z').outcome.state)
        .toBe('unresolved');
      open(service, 'cancelled');
      service.lifecycle.cancel({transactionId: 'cancelled', reason: 'mutual end', at: NOW});
      expect(service.view('cancelled', NOW).events).toHaveLength(0);
      open(service, 'refund');
      await fund(service, 'refund');
      await service.lifecycle.refund({transactionId: 'refund', at: NOW});
      expect(service.view('refund', NOW).events).toHaveLength(0);
      expect(store.listReliabilityStates()).toEqual(states);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(1);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('survives a database restart and reads fresh state from another connection', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cumulative-scoring-'));
    const path = join(directory, 'agent.sqlite');
    let store = AgentStore.open(path);
    let other: AgentStore|undefined;
    try {
      const first = serviceFor(store);
      await settle(first, 'first');
      first.view('first', NOW);
      store.close();
      store = AgentStore.open(path);
      other = AgentStore.open(path);
      const restarted = serviceFor(store);
      const second = serviceFor(other);
      expect(restarted.view('first', NOW).termsDecisions[0]?.inputs.eventCount).toBe(1);
      await settle(second, 'second');
      second.view('second', NOW);
      expect(restarted.view('first', NOW).termsDecisions[0]?.inputs.eventCount).toBe(2);
      await settle(restarted, 'third');
      restarted.view('third', NOW);
      expect(second.view('second', NOW).termsDecisions[0]?.inputs.eventCount).toBe(3);
      for (const state of store.listReliabilityStates()) {
        expect(state).toMatchObject({alpha: 4, beta: 1, eventCount: 3});
      }
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(3);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(3);
    } finally {
      other?.close();
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('rolls back every projection write if a later terms insert fails, then retries once', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      await settle(service, 'baseline');
      service.view('baseline', NOW);
      const states = store.listReliabilityStates();
      const buyerTerms = store.listTermsDecisions('buyer', 'delivery');
      const sellerTerms = store.listTermsDecisions('seller', 'delivery');
      await settle(service, 'retry');
      const insert = store.insertTermsDecision.bind(store);
      let writes = 0;
      const failure = spyOn(store, 'insertTermsDecision').mockImplementation((decision) => {
        if (++writes === 2) throw new Error('injected terms write failure');
        return insert(decision);
      });
      try {
        expect(() => service.view('retry', NOW)).toThrow('injected terms write failure');
      } finally {
        failure.mockRestore();
      }
      expect(store.listReliabilityEventsForTransaction('retry')).toHaveLength(0);
      expect(store.listReliabilityStates()).toEqual(states);
      expect(store.listTermsDecisions('buyer', 'delivery')).toEqual(buyerTerms);
      expect(store.listTermsDecisions('seller', 'delivery')).toEqual(sellerTerms);
      expect(service.view('retry', NOW).termsDecisions[0]?.inputs.eventCount).toBe(2);
      serviceFor(store).view('retry', NOW);
      expect(store.listReliabilityEventsForTransaction('retry')).toHaveLength(2);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(2);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(2);
      for (const state of store.listReliabilityStates()) {
        expect(state).toMatchObject({alpha: 3, beta: 1, eventCount: 2});
      }
    } finally {
      store.close();
    }
  });

  test('applies only the missing role when one event was already stored', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      await settle(service, 'baseline');
      service.view('baseline', NOW);
      await settle(service, 'partial');
      const defaults = DEFAULT_RELIABILITY_POLICIES;
      const flowed = flowLifecycleOutcome(
        service.lifecycle.getTransaction('partial'),
        service.lifecycle.outcomeFor('partial', {now: NOW}),
        defaults.scoring, defaults.decay, defaults.fees, NOW, new Map(),
        {states: store.listReliabilityStates()},
      );
      const buyerIndex = flowed.events.findIndex((event) => event.role === 'buyer');
      store.insertReliabilityEvent(flowed.events[buyerIndex]!);
      store.saveReliabilityState(flowed.states[buyerIndex]!);
      store.insertTermsDecision(flowed.decisions[buyerIndex]!);
      expect(serviceFor(store).view('partial', NOW).termsDecisions
        .map((decision) => decision.inputs.eventCount)).toEqual([2, 2]);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(2);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(2);
      for (const state of store.listReliabilityStates()) {
        expect(state).toMatchObject({alpha: 3, beta: 1, eventCount: 2});
      }
    } finally {
      store.close();
    }
  });

  test('recovers a missing legacy posterior from recorded events without double counting', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      // The old flow could commit events before writing either score row.
      for (const id of ['first', 'second']) {
        await settle(service, id);
        const transaction = service.lifecycle.getTransaction(id);
        const outcome = service.lifecycle.outcomeFor(id, {now: NOW});
        for (const event of outcomeToEvents(transaction, outcome)) {
          store.insertReliabilityEvent(event);
        }
      }
      expect(store.listReliabilityStates()).toHaveLength(0);
      const restarted = serviceFor(store);
      expect(restarted.view('first', NOW).termsDecisions
        .map((decision) => decision.inputs.eventCount)).toEqual([2, 2]);
      restarted.view('second', NOW);
      for (const state of store.listReliabilityStates()) {
        expect(state).toMatchObject({alpha: 3, beta: 1, eventCount: 2});
      }
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(1);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(1);
      await settle(restarted, 'third');
      restarted.view('third', NOW);
      restarted.view('first', NOW);
      for (const state of store.listReliabilityStates()) {
        expect(state).toMatchObject({alpha: 4, beta: 1, eventCount: 3});
      }
      expect(store.listReliabilityEventsForTransaction('first')).toHaveLength(2);
      expect(store.listTermsDecisions('buyer', 'delivery')).toHaveLength(2);
      expect(store.listTermsDecisions('seller', 'delivery')).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  test('stored posteriors replace fixture score rows for the same triple', async () => {
    const store = AgentStore.open();
    try {
      const service = serviceFor(store);
      await settle(service, 'fixture-update', {
        buyerId: 'entity-new', sellerId: 'entity-established', type: 'service',
      });
      service.view('fixture-update', NOW);
      const url = new URL('http://localhost/reliability/scores?entityId=entity-new');
      const route = createPlumbingRoutes().find((entry) => entry.path === url.pathname);
      if (!route) throw new Error('missing scores route');
      const response = await route.handler(new Request(url), url, store);
      const scores = await response.json() as ScoreView[];
      expect(scores.filter((score) => score.category === 'fulfillment' && score.role === 'buyer'))
        .toHaveLength(1);
      expect(scores.find((score) => score.category === 'fulfillment' && score.role === 'buyer')
        ?.eventCount).toBe(1);
      expect(scores.find((score) => score.category === 'payment' && score.role === 'seller')
        ?.eventCount).toBe(0);
    } finally {
      store.close();
    }
  });
});
