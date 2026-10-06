/** @fileoverview Paper pool accounting, isolation, and durable retries. */

import {describe, expect, test} from 'bun:test';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../../packages/db/src/index';
import {
  FIXTURE_ENTITIES, FIXTURE_TRANSACTIONS,
} from '../../packages/reliability/src/index';
import type {
  DealFundingRequest, PaperPoolDeposit,
} from '../../packages/reliability/src/omnibus-funding';
import {PaperOmnibusFunding} from './omnibus-funding';

const AT = '2026-10-06T12:00:00.000Z';
const BUYER = 'entity-established';
const OTHER_BUYER = 'entity-new';

function seed(store: AgentStore): void {
  for (const entity of FIXTURE_ENTITIES) store.insertEntity(entity);
  for (const [id, buyer] of [
    ['deal-a', BUYER], ['deal-b', BUYER], ['deal-c', OTHER_BUYER],
  ]) {
    store.insertTransaction({
      ...FIXTURE_TRANSACTIONS[1]!, id: id!, completedAt: undefined,
      participants: [
        {entityId: buyer!, role: 'buyer'},
        {entityId: 'entity-farm-a', role: 'seller'},
      ],
    });
  }
}

function deposit(
  businessId = BUYER, amountLovelace = 10_000_000,
): Omit<PaperPoolDeposit, 'poolId'> {
  return {
    idempotencyKey: `deposit-${businessId}`, businessId,
    sourceAddress: `paper:business:${businessId}`,
    depositTxHash: `paper:deposit:${businessId}`, outputIndex: 0,
    amountLovelace, at: AT,
  };
}

function request(
  transactionId = 'deal-a', amountLovelace = 3_000_000, businessId = BUYER,
): DealFundingRequest {
  return {
    idempotencyKey: `fund-${transactionId}`, transactionId,
    businessId, amountLovelace, at: AT,
  };
}

describe('paper omnibus funding', () => {
  test('shares the pool, isolates balances, and omits ownership from transfers', async () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const funding = new PaperOmnibusFunding(store);
      funding.recordDeposit(deposit());
      funding.recordDeposit(deposit(OTHER_BUYER, 5_000_000));
      const first = await funding.fund(request());
      const second = await funding.fund(request('deal-b', 2_000_000));
      const third = await funding.fund(request('deal-c', 1_000_000, OTHER_BUYER));
      expect(funding.simulated).toBe(true);
      expect(funding.broadcast).toBe(false);
      expect(first.mode).toBe('paper');
      expect(first.simulated).toBe(true);
      expect(first.fromAddress).toBe('paper:pool:platform');
      expect(second.fromAddress).toBe(first.fromAddress);
      expect(third.fromAddress).toBe(first.fromAddress);
      expect(new Set([first.toAddress, second.toAddress, third.toAddress]).size).toBe(3);
      expect(Object.keys(first).sort()).toEqual([
        'amountLovelace', 'fromAddress', 'mode', 'simulated', 'toAddress', 'txHash',
      ]);
      for (const privateReference of [BUYER, 'deal-a', deposit().depositTxHash]) {
        expect(JSON.stringify(first)).not.toContain(privateReference);
      }
      expect(funding.balance(BUYER)).toEqual({
        depositedLovelace: 10_000_000,
        allocatedLovelace: 5_000_000,
        availableLovelace: 5_000_000,
      });
      expect(funding.balance(OTHER_BUYER).availableLovelace).toBe(4_000_000);
    } finally {
      store.close();
    }
  });

  test('credits retries once and rejects conflicts or reuse of a deposit output', () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const funding = new PaperOmnibusFunding(store);
      const saved = funding.recordDeposit(deposit());
      expect(funding.recordDeposit({...deposit(), at: '2026-10-07T00:00:00Z'})).toEqual(saved);
      for (const change of [
        {amountLovelace: 1}, {businessId: OTHER_BUYER}, {outputIndex: 1},
        {sourceAddress: 'paper:business:other'}, {depositTxHash: 'other'},
      ]) {
        expect(() => funding.recordDeposit({...deposit(), ...change})).toThrow('conflicts');
      }
      expect(() => funding.recordDeposit({
        ...deposit(), idempotencyKey: 'duplicate-output', businessId: OTHER_BUYER,
      })).toThrow();
      expect(funding.balance(BUYER).availableLovelace).toBe(10_000_000);
      expect(funding.balance(OTHER_BUYER).availableLovelace).toBe(0);
      // A different output from the same transaction is a separate credit.
      funding.recordDeposit({...deposit(), idempotencyKey: 'output-1', outputIndex: 1});
      expect(funding.balance(BUYER).availableLovelace).toBe(20_000_000);
    } finally {
      store.close();
    }
  });

  test('rejects overspending, another buyer, and duplicate deal allocation', async () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const funding = new PaperOmnibusFunding(store);
      funding.recordDeposit(deposit());
      funding.recordDeposit(deposit(OTHER_BUYER, 50_000_000));
      await expect(funding.fund(request('deal-a', 11_000_000))).rejects.toThrow('insufficient');
      await expect(funding.fund(request('missing'))).rejects.toThrow('deal buyer');
      await expect(funding.fund(request('deal-a', 1, OTHER_BUYER))).rejects.toThrow('deal buyer');
      const first = await funding.fund(request('deal-a', 7_000_000));
      expect(await funding.fund(request('deal-a', 7_000_000))).toEqual(first);
      await expect(funding.fund(request('deal-b', 4_000_000))).rejects.toThrow('insufficient');
      await expect(funding.fund({...request('deal-a', 7_000_000), idempotencyKey: 'second-key'})).rejects.toThrow();
      for (const change of [
        {amountLovelace: 1}, {businessId: OTHER_BUYER}, {transactionId: 'deal-b'},
      ]) {
        await expect(funding.fund({...request('deal-a', 7_000_000), ...change})).rejects.toThrow('conflicts');
      }
      expect(funding.balance(BUYER).availableLovelace).toBe(3_000_000);
      expect(funding.balance(OTHER_BUYER).availableLovelace).toBe(50_000_000);
    } finally {
      store.close();
    }
  });

  test('rejects invalid amounts and keeps failed credits out of the ledger', async () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const funding = new PaperOmnibusFunding(store);
      for (const amountLovelace of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => funding.recordDeposit({...deposit(), amountLovelace})).toThrow();
        await expect(funding.fund({...request(), amountLovelace})).rejects.toThrow();
      }
      expect(() => funding.recordDeposit({...deposit(), outputIndex: -1})).toThrow();
      expect(() => funding.recordDeposit({...deposit(), sourceAddress: 'addr_test1real'})).toThrow('paper');
      expect(() => funding.recordDeposit({...deposit(), at: 'invalid'})).toThrow('timestamp');
      expect(() => funding.recordDeposit(deposit('missing-business'))).toThrow();
      expect(funding.balance(BUYER).availableLovelace).toBe(0);
      funding.recordDeposit(deposit(BUYER, Number.MAX_SAFE_INTEGER));
      expect(() => funding.recordDeposit({
        ...deposit(BUYER, 1), idempotencyKey: 'overflow', depositTxHash: 'overflow',
      })).toThrow();
      expect(funding.balance(BUYER).availableLovelace).toBe(Number.MAX_SAFE_INTEGER);
    } finally {
      store.close();
    }
  });

  test('keeps pools separate and refuses live addresses or address changes', async () => {
    const store = AgentStore.open();
    try {
      seed(store);
      const funding = new PaperOmnibusFunding(store);
      funding.recordDeposit(deposit());
      expect(() => new PaperOmnibusFunding(store, {
        poolId: 'live', poolAddress: 'addr1real',
      })).toThrow('paper');
      expect(() => new PaperOmnibusFunding(store, {
        poolId: 'paper-cardano-pool', poolAddress: 'paper:pool:changed',
      })).toThrow('cannot change');
      const other = new PaperOmnibusFunding(store, {
        poolId: 'other-pool', poolAddress: 'paper:pool:other',
      });
      expect(other.balance(BUYER).availableLovelace).toBe(0);
      await expect(other.fund(request())).rejects.toThrow('insufficient');
      other.recordDeposit({...deposit(), idempotencyKey: 'other-credit', depositTxHash: 'other-output'});
      const transfer = await funding.fund(request());
      await expect(other.fund(request())).rejects.toThrow('conflicts');
      expect(transfer.fromAddress).toBe('paper:pool:platform');
    } finally {
      store.close();
    }
  });

  test('reopens credits and deal addresses and serializes competing allocations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'paper-omnibus-'));
    const filename = join(directory, 'agent.sqlite');
    let store = AgentStore.open(filename);
    let otherStore: AgentStore|undefined;
    try {
      seed(store);
      let funding = new PaperOmnibusFunding(store);
      const credit = funding.recordDeposit(deposit());
      const first = await funding.fund(request('deal-a', 7_000_000));
      store.close();
      store = AgentStore.open(filename);
      funding = new PaperOmnibusFunding(store);
      expect(funding.recordDeposit(deposit())).toEqual(credit);
      expect(await funding.fund(request('deal-a', 7_000_000))).toEqual(first);
      otherStore = AgentStore.open(filename);
      const other = new PaperOmnibusFunding(otherStore);
      const results = await Promise.allSettled([
        funding.fund(request('deal-b', 3_000_000)),
        other.fund({...request('deal-b', 3_000_000), idempotencyKey: 'competing'}),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(funding.balance(BUYER).availableLovelace).toBe(0);
      expect(other.balance(BUYER)).toEqual(funding.balance(BUYER));
    } finally {
      otherStore?.close();
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });
});
