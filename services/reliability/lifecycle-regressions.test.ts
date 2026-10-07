/** @fileoverview Regression tests for marketplace lifecycle and stored read gaps. */
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {AgentStore} from '../../packages/db/src/index';
import {EscrowTransactionLifecycle} from '../../packages/reliability/src/lifecycle';
import type {EscrowPort} from '../../packages/reliability/src/escrow-port';
import {LifecycleService} from './lifecycle-service';
import {createSimulatedMasumiEscrow} from './masumi-escrow';
import {createLaneARoutes} from './routes-lane-a';
import {createPlumbingRoutes} from './routes-plumbing';
import type {ReliabilityRoute} from './route';

const AT = '2026-10-07T00:00:00.000Z';
const LATER = '2026-10-08T00:00:00.000Z';
const DEADLINE = '2026-10-09T00:00:00.000Z';
const AFTER = '2026-10-10T00:00:00.000Z';

function service(store: AgentStore, escrow?: EscrowPort): LifecycleService {
  return new LifecycleService(store, {escrow: escrow ?? createSimulatedMasumiEscrow(store)});
}

function open(s: LifecycleService, id = 'sale'): void {
  s.ensureParty('buyer', AT);
  s.ensureParty('seller', AT);
  s.lifecycle.open({id, type: 'goods', buyerId: 'buyer', sellerId: 'seller',
    terms: {goods: 'cable'}, value: 50, at: AT});
}

function funding(transactionId = 'sale') {
  return {transactionId, amountLovelace: 50_000_000,
    sellerReturnAddress: 'addr_test1_seller', disputeWindowEnds: DEADLINE, at: AT};
}

async function settled(s: LifecycleService, id = 'sale'): Promise<void> {
  open(s, id);
  await s.lifecycle.fund(funding(id));
  s.lifecycle.confirmDelivery({transactionId: id, at: AT,
    evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer'}});
  await s.lifecycle.release({transactionId: id, at: AT});
}

async function reverse(s: LifecycleService): Promise<void> {
  s.lifecycle.openDispute({transactionId: 'sale', resolver: 'reviewer', resolveBy: DEADLINE, at: LATER});
  await s.lifecycle.resolveDispute({transactionId: 'sale', resolver: 'reviewer',
    decision: 'uphold_buyer', at: LATER});
}

function live(store: AgentStore) {
  const paper = createSimulatedMasumiEscrow(store);
  const counts = {fund: 0, release: 0, refund: 0};
  const confirmed = {fund: false, release: false, refund: false};
  const port: EscrowPort = {
    simulated: false, broadcast: true,
    async fund(input) {
      counts.fund++;
      return {...await paper.fund(input), simulated: false, mode: 'live'};
    },
    async release(session, hash) {
      counts.release++;
      return {...await paper.release(session, hash), simulated: false, mode: 'live'};
    },
    async refund(session) {
      counts.refund++;
      return {...await paper.refund(session), simulated: false, mode: 'live'};
    },
    async status() {
      return {simulated: false, mode: 'live', onChainState: 'Withdrawn'};
    },
    async verify(session, action) {
      return {simulated: false, mode: 'live', verified: confirmed[action],
        onChainState: action === 'fund' ? 'FundsLocked' : action === 'release' ? 'Withdrawn' : 'RefundWithdrawn',
        txHash: session.txHash};
    },
    async mutualTerminate(session, consent) {
      return {...await paper.mutualTerminate(session, consent), simulated: false, mode: 'live'};
    },
  };
  return {port, counts, confirmed};
}

async function request(routes: ReliabilityRoute[], store: AgentStore, path: string, body?: unknown): Promise<Response> {
  const url = new URL(`http://local${path}`);
  const route = routes.find((entry) => entry.path === url.pathname && entry.method === (body ? 'POST' : 'GET'));
  if (!route) throw new Error('missing route');
  return route.handler(new Request(url, body ? {method: 'POST', body: JSON.stringify(body)} : {}), url, store);
}

describe('marketplace correctness regressions', () => {
  test('retracts success and rebuilds both roles after a seller-fault dispute, independent of prior reads', async () => {
    for (const readFirst of [false, true]) {
      const store = AgentStore.open();
      try {
        const s = service(store);
        await settled(s);
        if (readFirst) s.view('sale', AT);
        await reverse(s);
        expect(s.view('sale', LATER).outcome).toMatchObject({state: 'failed', fault: 'seller'});
        expect(store.getReliabilityState('seller', 'delivery', 'seller'))
          .toMatchObject({alpha: 1, beta: 2, eventCount: 1});
        const buyer = store.getReliabilityState('buyer', 'delivery', 'buyer');
        if (buyer) expect(buyer).toMatchObject({alpha: 1, beta: 1, eventCount: 0});
        expect(store.listReliabilityEventsForTransaction('sale').map((event) => event.outcome)).toEqual(['failure']);
        const state = store.listReliabilityStates();
        s.view('sale', AFTER);
        expect(store.listReliabilityStates()).toEqual(state);
      } finally { store.close(); }
    }
  });

  test('keeps an imported baseline while retracting only the corrected transaction', async () => {
    const store = AgentStore.open();
    try {
      const s = service(store);
      s.ensureParty('seller', AT);
      store.saveReliabilityState({entityId: 'seller', category: 'delivery', role: 'seller',
        alpha: 10, beta: 4, eventCount: 12, updatedAt: AT});
      await settled(s);
      s.view('sale', AT);
      await reverse(s);
      s.view('sale', LATER);
      expect(store.getReliabilityState('seller', 'delivery', 'seller'))
        .toMatchObject({alpha: 10, beta: 5, eventCount: 13});
    } finally { store.close(); }
  });

  test('keeps terminal decision and event times stable across later reads', async () => {
    const store = AgentStore.open();
    try {
      const s = service(store);
      await settled(s);
      const first = s.view('sale', LATER);
      const second = s.view('sale', AFTER);
      expect(second.outcome.decidedAt).toBe(AT);
      expect(second.events).toEqual(first.events);
      expect(store.getTransaction('sale')?.completedAt).toBe(AT);
    } finally { store.close(); }
  });

  test('rejects backdated funding before an external call and backdated terms', async () => {
    const store = AgentStore.open();
    try {
      const l = live(store);
      const s = service(store, l.port);
      open(s);
      await expect(s.lifecycle.fund({...funding(), at: '2020-01-01T00:00:00.000Z'}))
        .rejects.toThrow('must not precede');
      expect(l.counts.fund).toBe(0);
      expect(() => s.lifecycle.amendTerms('sale', {}, 'changed', '2020-01-01T00:00:00.000Z'))
        .toThrow('must not precede');
    } finally { store.close(); }
  });

  test('cannot reverse a recorded timeout through an earlier read or resolution time', async () => {
    const store = AgentStore.open();
    try {
      const s = service(store);
      open(s);
      await s.lifecycle.fund(funding());
      s.lifecycle.openDispute({transactionId: 'sale', resolver: 'reviewer', resolveBy: DEADLINE, at: AT});
      expect(s.view('sale', AFTER).outcome).toMatchObject({state: 'unresolved', decidedAt: DEADLINE});
      expect(s.view('sale', AT).outcome.state).toBe('unresolved');
      await expect(s.lifecycle.resolveDispute({transactionId: 'sale', resolver: 'reviewer', decision: 'uphold_seller', at: AT}))
        .rejects.toThrow('deadline has passed');
    } finally { store.close(); }
  });

  test('checks server time on plain reads and resolver actions without a timeout read', async () => {
    for (const readFirst of [false, true]) {
      const store = AgentStore.open();
      try {
        const s = service(store);
        open(s);
        await s.lifecycle.fund(funding());
        s.lifecycle.openDispute({transactionId: 'sale', resolver: 'reviewer', resolveBy: DEADLINE, at: AT});
        const routes = createLaneARoutes({clock: () => AFTER});
        if (readFirst) {
          const read = await request(routes, store, '/reliability/lifecycle?transactionId=sale');
          expect((await read.json() as {outcome: {state: string}}).outcome.state).toBe('unresolved');
        }
        const resolved = await request(routes, store, '/reliability/lifecycle/transition', {
          action: 'resolve', transactionId: 'sale', resolver: 'reviewer', decision: 'uphold_seller', at: AT,
        });
        expect(resolved.status).toBe(400);
      } finally { store.close(); }
    }
  });

  test('serializes concurrent funding, replays the original result, and rejects changed bindings', async () => {
    const store = AgentStore.open();
    try {
      const l = live(store);
      l.confirmed.fund = true;
      const s = service(store, l.port);
      open(s);
      const [first, second] = await Promise.all([s.lifecycle.fund(funding()), s.lifecycle.fund(funding())]);
      expect(second).toEqual(first);
      expect(await s.lifecycle.fund({...funding(), at: LATER})).toEqual(first);
      expect(l.counts.fund).toBe(1);
      await expect(s.lifecycle.fund({...funding(), amountLovelace: 1})).rejects.toThrow('conflicts');
    } finally { store.close(); }
  });

  test('retains pending funding across restart and polls proof without a second purchase', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifecycle-journal-'));
    const path = join(directory, 'agent.sqlite');
    let store = AgentStore.open(path);
    try {
      const l = live(store);
      const s = service(store, l.port);
      open(s);
      await expect(s.lifecycle.fund(funding())).rejects.toThrow('pending confirmed');
      expect(s.lifecycle.currentStage('sale')).toBe('offer_accepted');
      store.close();
      store = AgentStore.open(path);
      l.confirmed.fund = true;
      const restarted = service(store, l.port);
      await restarted.lifecycle.fund({...funding(), at: LATER});
      expect(l.counts.fund).toBe(1);
      expect(restarted.lifecycle.currentStage('sale')).toBe('escrow_funded');
    } finally { store.close(); rmSync(directory, {recursive: true, force: true}); }
  });

  test('requires verified payout or refund and does not resubmit accepted requests', async () => {
    for (const action of ['release', 'refund'] as const) {
      const store = AgentStore.open();
      try {
        const l = live(store);
        l.confirmed.fund = true;
        const s = service(store, l.port);
        open(s);
        await s.lifecycle.fund(funding());
        if (action === 'release') s.lifecycle.confirmDelivery({transactionId: 'sale', at: AT,
          evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer'}});
        await expect(s.lifecycle[action]({transactionId: 'sale', at: AT})).rejects.toThrow('pending confirmed');
        expect(s.view('sale', AT).outcome.state).toBe('pending');
        expect(store.listReliabilityEventsForTransaction('sale')).toHaveLength(0);
        l.confirmed[action] = true;
        const result = await s.lifecycle[action]({transactionId: 'sale', at: LATER});
        expect(result.evidence.settlementVerified).toBe(true);
        expect(l.counts[action]).toBe(1);
        expect(await s.lifecycle[action]({transactionId: 'sale', at: AFTER})).toEqual(result);
      } finally { store.close(); }
    }
  });

  test('resumes a resolver decision after accepted refund waits for confirmation', async () => {
    const store = AgentStore.open();
    try {
      const l = live(store);
      l.confirmed.fund = true;
      const s = service(store, l.port);
      open(s);
      await s.lifecycle.fund(funding());
      s.lifecycle.openDispute({transactionId: 'sale', resolver: 'reviewer', resolveBy: DEADLINE, at: AT});
      const resolve = {transactionId: 'sale', resolver: 'reviewer', decision: 'uphold_buyer' as const, at: AT};
      await expect(s.lifecycle.resolveDispute(resolve)).rejects.toThrow('pending confirmed');
      expect(s.lifecycle.currentStage('sale')).toBe('dispute_resolved');
      l.confirmed.refund = true;
      await s.lifecycle.resolveDispute({...resolve, at: LATER});
      expect(l.counts.refund).toBe(1);
      expect(s.view('sale', LATER).outcome).toMatchObject({state: 'failed', fault: 'seller'});
    } finally { store.close(); }
  });

  test('does not submit twice when two database connections race the same command', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifecycle-race-'));
    const path = join(directory, 'agent.sqlite');
    const firstStore = AgentStore.open(path);
    const secondStore = AgentStore.open(path);
    let resume: (() => void)|undefined;
    let entered: (() => void)|undefined;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    try {
      const l = live(firstStore);
      l.confirmed.fund = true;
      const original = l.port.fund.bind(l.port);
      l.port.fund = async (input) => { entered?.(); await paused; return original(input); };
      const first = service(firstStore, l.port);
      const second = service(secondStore, l.port);
      open(first);
      const pending = first.lifecycle.fund(funding());
      await started;
      await expect(second.lifecycle.fund(funding())).rejects.toThrow('reconciliation is required');
      expect(secondStore.getPendingLifecycleCommand('sale')).toBeDefined();
      expect(() => second.lifecycle.amendTerms('sale', {}, 'racing update', AT)).toThrow('command is pending');
      resume?.();
      const result = await pending;
      expect(await second.lifecycle.fund(funding())).toEqual(result);
      expect(l.counts.fund).toBe(1);
    } finally {
      resume?.(); firstStore.close(); secondStore.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('blocks an ambiguous external response after restart and rejects a new identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lifecycle-unknown-'));
    const path = join(directory, 'agent.sqlite');
    let store = AgentStore.open(path);
    let calls = 0;
    try {
      const paper = createSimulatedMasumiEscrow(store);
      const port: EscrowPort = {...paper, simulated: true, broadcast: false,
        fund: async () => { calls++; throw new Error('lost response'); },
        release: paper.release.bind(paper), refund: paper.refund.bind(paper),
        status: paper.status.bind(paper), mutualTerminate: paper.mutualTerminate.bind(paper)};
      const s = service(store, port);
      open(s);
      await expect(s.lifecycle.fund(funding())).rejects.toThrow('lost response');
      store.close();
      store = AgentStore.open(path);
      const restarted = service(store, port);
      await expect(restarted.lifecycle.fund(funding())).rejects.toThrow('reconciliation is required');
      await expect(restarted.lifecycle.fund({...funding(), commandId: 'new'})).rejects.toThrow('command is pending');
      expect(calls).toBe(1);
    } finally { store.close(); rmSync(directory, {recursive: true, force: true}); }
  });

  test('returns pending and conflict responses, then completes from the saved external response', async () => {
    const store = AgentStore.open();
    try {
      const l = live(store);
      open(service(store, l.port));
      const routes = createLaneARoutes({clock: () => AT, escrowForStore: () => l.port});
      const body = {action: 'fund', ...funding(), commandId: 'purchase-1'};
      const pending = await request(routes, store, '/reliability/lifecycle/transition', body);
      expect(pending.status).toBe(202);
      expect(await pending.json()).toMatchObject({pending: true});
      expect((await request(routes, store, '/reliability/lifecycle/transition', {
        ...body, amountLovelace: 60_000_000,
      })).status).toBe(409);
      expect((await request(routes, store, '/reliability/lifecycle/transition', {
        action: 'deliver', transactionId: 'sale', at: AT,
        evidence: {deliveryTier: 'buyer_confirmation', confirmedBy: 'buyer'},
      })).status).toBe(409);
      l.confirmed.fund = true;
      const completed = await request(routes, store, '/reliability/lifecycle/transition', {...body, at: LATER});
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({stage: 'escrow_funded', transition: {at: AT}});
      expect(l.counts.fund).toBe(1);
    } finally { store.close(); }
  });

  test('forwards buyer fault, validates it, and serves stored collections and receipts', async () => {
    const store = AgentStore.open();
    try {
      const s = service(store);
      open(s);
      await s.lifecycle.fund(funding());
      store.saveListing({id: 'stored-listing', sellerId: 'seller', transactionType: 'goods',
        title: 'Stored cable', price: 50, requiredTerms: {}, createdAt: AT});
      const writes = createLaneARoutes({clock: () => AT});
      expect((await request(writes, store, '/reliability/lifecycle/transition', {
        action: 'refund', transactionId: 'sale', at: AT, fault: 'seller',
      })).status).toBe(400);
      const refunded = await request(writes, store, '/reliability/lifecycle/transition', {
        action: 'refund', transactionId: 'sale', at: AT, fault: 'buyer',
      });
      expect(refunded.status).toBe(200);
      expect((await refunded.json() as {outcome: {fault: string}}).outcome.fault).toBe('buyer');
      const reads = createPlumbingRoutes();
      for (const path of ['/reliability/entities?id=buyer', '/reliability/listings?id=stored-listing',
        '/reliability/transactions?id=sale', '/reliability/receipts?transactionId=sale']) {
        expect((await request(reads, store, path)).status).toBe(200);
      }
      const transactions = await request(reads, store, '/reliability/transactions');
      expect((await transactions.json() as {id: string}[]).some((row) => row.id === 'sale')).toBe(true);
      const receipt = await request(reads, store, '/reliability/receipts?transactionId=sale');
      expect((await receipt.json() as {events: {role: string}[]}).events.map((event) => event.role)).toEqual(['buyer']);
    } finally { store.close(); }
  });

  test('keeps unverified legacy live terminal records out of reliability scores', async () => {
    const store = AgentStore.open();
    try {
      const s = service(store);
      await settled(s);
      const transitions = store.listLifecycleTransitions('sale');
      const last = transitions[transitions.length - 1]!;
      const evidence = {...JSON.parse(last.evidenceJson), mode: 'live', simulated: false};
      delete evidence.settlementVerified;
      store.insertLifecycleTransition({...last, evidenceJson: JSON.stringify(evidence)});
      expect(s.view('sale', LATER).outcome).toMatchObject({state: 'pending', verificationMethod: 'unverified'});
      expect(store.listReliabilityEventsForTransaction('sale')).toHaveLength(0);
      expect(new EscrowTransactionLifecycle({store}).currentStage('sale')).toBe('payment_settled');
    } finally { store.close(); }
  });
});
