/**
 * @fileoverview Marketplace startup and shared control store regression tests.
 */

import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../packages/db/src';
import {createAgentRuntime} from './agent-runtime';
import {startMarketplace} from './control-api';
import {openControlStore} from './control-store';

describe('marketplace control startup', () => {
  test('serves the marketplace without creating a trading book or enabling trading writes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-startup-'));
    const databasePath = join(directory, 'nested', 'agent.sqlite');
    const server = startMarketplace(0, {databasePath, auditFile: join(directory, 'audit.jsonl')});
    const store = AgentStore.open(databasePath);
    const origin = `http://127.0.0.1:${server.port}`;
    try {
      expect(store.getAgentState()).toBeUndefined();
      const entities = await fetch(`${origin}/reliability/entities`);
      expect(entities.status).toBe(200);
      expect((await entities.json() as unknown[]).length).toBeGreaterThan(0);
      store.insertEntity({
        id: 'shop', displayName: 'Shop', wallets: [], roles: ['seller'],
        kycStatus: 'verified', kycTier: 'basic', createdAt: new Date().toISOString(),
      });
      const listed = await fetch(`${origin}/reliability/listings`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({
          id: 'cable', sellerId: 'shop', transactionType: 'goods', title: 'USB cable',
          price: 40, at: new Date().toISOString(),
        }),
      });
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({mode: 'paper', listing: {id: 'cable'}});
      expect(store.listListings().find((listing) => listing.id === 'cable')?.title).toBe('USB cable');
      const state = await fetch(`${origin}/agent/state`);
      expect(state.status).toBe(404);
      expect(await state.json()).toEqual({error: 'no stored legacy agent state'});
      for (const path of ['/orders', '/agent/policy', '/agent/debug/reset', '/agent/marks', '/positions/close', '/markets/resolve']) {
        const response = await fetch(`${origin}${path}`, {
          method: 'POST', headers: {'content-type': 'application/json'}, body: '{}',
        });
        expect(response.status).toBe(404);
        await response.text();
      }
      expect(store.getAgentState()).toBeUndefined();
      const db = new Database(databasePath);
      try {
        expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM policy').get()?.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      await server.stop(true);
      await server.stop(true);
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('keeps the audit demo routes available', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-audit-'));
    const server = startMarketplace(0, {databasePath: ':memory:', auditFile: join(directory, 'audit.jsonl')});
    const origin = `http://127.0.0.1:${server.port}`;
    const body = {cycleId: 'paper-demo', events: [{type: 'cycle_end', detail: 'done', mode: 'paper'}]};
    try {
      const response = await fetch(`${origin}/audit`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ok: true, events: 1});
      expect(await (await fetch(`${origin}/audit`)).json()).toMatchObject([body]);
    } finally {
      await server.stop(true);
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('reads an existing paper book without advancing its day or changing stored state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-snapshot-'));
    const store = AgentStore.open();
    const runtime = createAgentRuntime({store, now: () => new Date('2026-10-01T12:00:00.000Z')});
    const before = store.getAgentState();
    const server = startMarketplace(0, {store, auditFile: join(directory, 'audit.jsonl')});
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/agent/state`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        policy: store.getPolicy(before!.policyId)?.policy,
        portfolio: {...before!.portfolio, ...before!.accounting, unrealizedPnl: 0},
        quoteSource: {status: 'disabled', errors: []},
      });
      expect(store.getAgentState()).toEqual(before);
      expect(store.listDailySummaries()).toEqual([]);
    } finally {
      await server.stop(true);
      runtime.close();
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('starts the marketplace even when a legacy trading book is unreadable', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-legacy-corrupt-'));
    const databasePath = join(directory, 'agent.sqlite');
    const runtime = createAgentRuntime({databasePath});
    runtime.close();
    const db = new Database(databasePath);
    db.run("UPDATE agent_state SET positions_json = 'broken JSON'");
    let server: ReturnType<typeof startMarketplace>|undefined;
    try {
      server = startMarketplace(0, {databasePath, auditFile: join(directory, 'audit.jsonl')});
      const response = await fetch(`http://127.0.0.1:${server.port}/reliability/listings`);
      expect(response.status).toBe(200);
      await response.text();
      expect(db.query<{positions: string}, []>('SELECT positions_json AS positions FROM agent_state').get()?.positions)
        .toBe('broken JSON');
    } finally {
      await server?.stop(true);
      db.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('leaves a supplied store open after repeated stops or a failed server start', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'marketplace-borrowed-store-'));
    const store = AgentStore.open();
    const options = {store, auditFile: join(directory, 'audit.jsonl')};
    const server = startMarketplace(0, options);
    try {
      expect(() => startMarketplace(server.port, options)).toThrow();
      expect(store.listEntities()).toEqual([]);
      await server.stop(true);
      await server.stop(true);
      expect(store.listEntities()).toEqual([]);
    } finally {
      await server.stop(true);
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });
});

test('control store setup uses a supplied store before resolving the database path', () => {
  const store = AgentStore.open();
  try {
    expect(openControlStore({store, databasePath: '/unavailable/control.sqlite'})).toBe(store);
  } finally {
    store.close();
  }
});
