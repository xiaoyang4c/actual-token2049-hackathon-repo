/**
 * @fileoverview Settlement durability, atomic writes, and delivery isolation.
 */

import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  AgentStore, applyMigrations,
  type PaymentReceiptRecord, type SettlementObservationInput,
  type SettlementStatus,
} from '../src/index';
import {insertPaymentReceipt} from '../src/payment-receipts';
import {
  ensurePaymentSettlement, getPaymentSettlement,
  listPaymentSettlementObservations, recordPaymentSettlementObservation,
} from '../src/payment-settlements';

const START = '2026-10-04T00:00:00.000Z';
const CHECK = '2026-10-04T00:00:01.000Z';
const RETRY = '2026-10-04T00:00:10.000Z';

describe('payment settlement storage', () => {
  test('keeps scheduling independent from delivery and wakes only earlier', () => {
    const store = AgentStore.open();
    try {
      const receipt = store.insertPaymentReceipt(deliveredReceipt());
      expect(store.getPaymentSettlement(receipt.receiptId)).toBeUndefined();
      const initial = store.ensurePaymentSettlement(receipt.receiptId, START);
      expect(initial).toEqual({
        receiptId: receipt.receiptId,
        status: 'pending',
        nextCheckAt: START,
        attemptCount: 0,
        updatedAt: START,
      });
      expect(store.ensurePaymentSettlement(receipt.receiptId, RETRY)).toEqual(initial);
      expect(store.schedulePaymentSettlement(receipt.receiptId, RETRY)).toEqual(initial);
      expect(store.listDuePaymentSettlements('2026-10-03T23:59:59.000Z')).toEqual([]);
      expect(store.listDuePaymentSettlements(START)).toEqual([initial]);
      expect(store.getPaymentReceipt(receipt.receiptId)).toEqual(receipt);
    } finally {
      store.close();
    }
  });

  test('preserves verified facts on errors and retains them after a rollback observation', () => {
    const store = AgentStore.open();
    try {
      const receipt = store.insertPaymentReceipt(deliveredReceipt());
      store.recordPaymentSettlementObservation(observation({
        status: 'withdrawn', verified: true, nextCheckAt: null,
      }));
      const failed = store.recordPaymentSettlementObservation(observation({
        observedAt: CHECK, status: 'unknown', verified: false,
        error: 'Masumi timed out', nextCheckAt: RETRY,
      }));
      expect(failed).toEqual({
        receiptId: receipt.receiptId,
        status: 'withdrawn',
        lastVerifiedStatus: 'withdrawn',
        lastVerifiedAt: START,
        nextCheckAt: RETRY,
        attemptCount: 2,
        lastCheckedAt: CHECK,
        lastError: 'Masumi timed out',
        updatedAt: CHECK,
      });
      const reopened = store.recordPaymentSettlementObservation(observation({
        observedAt: RETRY, status: 'recovery_required', verified: false,
        nextCheckAt: '2026-10-04T00:01:00.000Z',
        evidenceJson: '{"reason":"withdrawal transaction rolled back"}',
      }));
      expect(reopened.status).toBe('recovery_required');
      expect(reopened.lastVerifiedStatus).toBe('withdrawn');
      expect(reopened.lastVerifiedAt).toBe(START);
      expect(reopened.lastError).toBeUndefined();
      expect(reopened.attemptCount).toBe(3);
      const history = store.listPaymentSettlementObservations(receipt.receiptId);
      expect(history.map((entry) => entry.status)).toEqual([
        'withdrawn', 'unknown', 'recovery_required',
      ]);
      expect(history[1]?.error).toBe('Masumi timed out');
      expect(history[2]?.evidenceJson).toContain('rolled back');
      expect(store.listPaymentSettlementObservations(receipt.receiptId, 2))
        .toEqual(history.slice(1));
      expect(store.getPaymentReceipt(receipt.receiptId)).toEqual(receipt);
    } finally {
      store.close();
    }
  });

  test('persists observations and pending schedules across a restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'payment-settlements-'));
    const filename = join(directory, 'payments.sqlite');
    let store = AgentStore.open(filename);
    try {
      store.insertPaymentReceipt(deliveredReceipt());
      store.insertPaymentReceipt(deliveredReceipt('stopped'));
      store.recordPaymentSettlementObservation(observation({
        status: 'refund_pending', verified: false, nextCheckAt: RETRY,
      }));
      store.recordPaymentSettlementObservation(observation({
        receiptId: 'stopped', status: 'refunded', verified: true, nextCheckAt: null,
      }));
      store.close();
      store = AgentStore.open(filename);
      expect(store.listDuePaymentSettlements(CHECK)).toEqual([]);
      expect(store.listDuePaymentSettlements(RETRY).map((entry) => entry.receiptId))
        .toEqual(['delivered']);
      expect(store.getPaymentSettlement('delivered')?.attemptCount).toBe(1);
      expect(store.getPaymentSettlement('stopped')?.lastVerifiedStatus).toBe('refunded');
      expect(store.listPaymentSettlementObservations('delivered')).toHaveLength(1);
      const stopped = store.getPaymentSettlement('stopped');
      if (stopped === undefined) throw new Error('missing refunded settlement');
      const woken = store.schedulePaymentSettlement('stopped', CHECK);
      expect(woken).toEqual({...stopped, nextCheckAt: CHECK});
      expect(store.listDuePaymentSettlements(RETRY, 1).map((entry) => entry.receiptId))
        .toEqual(['stopped']);
    } finally {
      store.close();
      rmSync(directory, {recursive: true, force: true});
    }
  });

  test('retains direct access to terminal proof after more than 100 API errors', () => {
    const store = AgentStore.open();
    try {
      store.insertPaymentReceipt(deliveredReceipt());
      expect(store.getLastVerifiedPaymentSettlementObservation('delivered')).toBeUndefined();
      store.recordPaymentSettlementObservation(observation({verified: true}));
      const depositProof = store.getLastVerifiedPaymentSettlementObservation('delivered');
      store.recordPaymentSettlementObservation(observation({
        observedAt: CHECK, status: 'withdrawn', verified: true, nextCheckAt: null,
        evidenceJson: '{"terminalSnapshot":{"txHash":"withdrawal-hash"}}',
      }));
      const terminalProof = store.getLastVerifiedPaymentSettlementObservation('delivered');
      for (let attempt = 0; attempt < 105; attempt++) {
        store.recordPaymentSettlementObservation(observation({
          observedAt: new Date(Date.parse(CHECK) + (attempt + 1) * 1000).toISOString(),
          status: 'unknown', verified: false, error: 'Masumi timed out', nextCheckAt: RETRY,
        }));
      }
      const displayed = store.listPaymentSettlementObservations('delivered');
      expect(displayed).toHaveLength(100);
      expect(displayed.every((entry) => !entry.verified)).toBe(true);
      expect(store.getPaymentSettlement('delivered')?.lastVerifiedStatus).toBe('withdrawn');
      expect(store.getLastVerifiedPaymentSettlementObservation('delivered'))
        .toEqual(terminalProof);
      expect(store.getLastVerifiedPaymentSettlementObservation('delivered', 'withdrawn'))
        .toEqual(terminalProof);
      expect(store.getLastVerifiedPaymentSettlementObservation('delivered', 'funds_locked'))
        .toEqual(depositProof);
      expect(store.getLastVerifiedPaymentSettlementObservation('delivered', 'refunded'))
        .toBeUndefined();
      expect(() => store.getLastVerifiedPaymentSettlementObservation(
        'delivered', 'seller_paid' as SettlementStatus,
      )).toThrow('unknown settlement status');
    } finally {
      store.close();
    }
  });

  test('rolls back appended evidence when the summary write fails', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      insertPaymentReceipt(db, deliveredReceipt());
      const previous = recordPaymentSettlementObservation(db, observation());
      const history = listPaymentSettlementObservations(db, 'delivered');
      db.run(`CREATE TRIGGER fail_settlement_write BEFORE UPDATE ON payment_settlements
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
      expect(() => recordPaymentSettlementObservation(db, observation({
        observedAt: CHECK, status: 'withdrawn', verified: true, nextCheckAt: null,
      }))).toThrow('simulated write failure');
      expect(getPaymentSettlement(db, 'delivered')).toEqual(previous);
      expect(listPaymentSettlementObservations(db, 'delivered')).toEqual(history);
    } finally {
      db.close();
    }
  });

  test('does not leave a new schedule behind when its first observation fails', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      insertPaymentReceipt(db, deliveredReceipt());
      db.run(`CREATE TRIGGER fail_settlement_write BEFORE UPDATE ON payment_settlements
        BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END`);
      expect(() => recordPaymentSettlementObservation(db, observation()))
        .toThrow('simulated write failure');
      expect(getPaymentSettlement(db, 'delivered')).toBeUndefined();
      expect(listPaymentSettlementObservations(db, 'delivered')).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('joins a receipt transaction without committing partial payment records', () => {
    const store = AgentStore.open();
    try {
      expect(() => store.transaction(() => {
        store.insertPaymentReceipt(deliveredReceipt());
        store.schedulePaymentSettlement('delivered', START);
        store.recordPaymentSettlementObservation(observation());
        throw new Error('simulated request failure');
      })).toThrow('simulated request failure');
      expect(store.getPaymentReceipt('delivered')).toBeUndefined();
      expect(store.getPaymentSettlement('delivered')).toBeUndefined();
      expect(store.listPaymentSettlementObservations('delivered')).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('keeps evidence immutable and requires a stored receipt', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      expect(() => ensurePaymentSettlement(db, 'missing', START))
        .toThrow('FOREIGN KEY constraint failed');
      expect(() => recordPaymentSettlementObservation(db, observation({receiptId: 'missing'})))
        .toThrow('FOREIGN KEY constraint failed');
      insertPaymentReceipt(db, deliveredReceipt());
      recordPaymentSettlementObservation(db, observation());
      expect(() => db.run('UPDATE payment_settlement_observations SET verified = 1'))
        .toThrow('settlement observations are append-only');
      expect(() => db.run('DELETE FROM payment_settlement_observations'))
        .toThrow('settlement observations are append-only');
      expect(listPaymentSettlementObservations(db, 'delivered')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test('validates input before writing and normalizes timestamps for due order', () => {
    const store = AgentStore.open();
    try {
      store.insertPaymentReceipt(deliveredReceipt());
      expect(() => store.recordPaymentSettlementObservation(observation({
        status: 'seller_paid' as SettlementStatus,
      }))).toThrow('unknown settlement status');
      expect(() => store.recordPaymentSettlementObservation(observation({
        evidenceJson: '{broken',
      }))).toThrow('evidenceJson must contain valid JSON');
      expect(() => store.recordPaymentSettlementObservation(observation({
        observedAt: 'not-a-date',
      }))).toThrow('observedAt must be a valid timestamp');
      expect(() => store.recordPaymentSettlementObservation(observation({
        nextCheckAt: 'not-a-date',
      }))).toThrow('nextCheckAt must be a valid timestamp');
      expect(() => store.recordPaymentSettlementObservation(observation({
        verified: true, error: 'failed to read state',
      }))).toThrow('an error observation cannot verify settlement');
      expect(store.getPaymentSettlement('delivered')).toBeUndefined();
      expect(store.listPaymentSettlementObservations('delivered')).toEqual([]);
      expect(() => store.listDuePaymentSettlements(START, -1))
        .toThrow('limit must be a positive integer');
      expect(() => store.listPaymentSettlementObservations('delivered', 1.5))
        .toThrow('limit must be a positive integer');
      expect(store.ensurePaymentSettlement('delivered', '2026-10-04T02:00:00+02:00')
        .nextCheckAt).toBe(START);
      expect(store.listDuePaymentSettlements(START)).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  test('backfills protocol receipts as pending without inferring legacy settlement', () => {
    const db = new Database(':memory:');
    try {
      db.run(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      )`);
      const names = [
        '001_initial.sql', '002_payment_lifecycle.sql',
        '003_agent_state.sql', '004_position_lifecycle.sql',
      ];
      for (const [index, name] of names.entries()) {
        db.run(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
        db.query('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(index + 1, name, START);
      }
      insertPaymentReceipt(db, {...deliveredReceipt('released'), status: 'released'});
      insertPaymentReceipt(db, {...deliveredReceipt('refunded'), status: 'refunded'});
      insertPaymentReceipt(db, {...deliveredReceipt('x402'), protocolData: undefined});
      applyMigrations(db);
      applyMigrations(db);
      for (const receiptId of ['released', 'refunded']) {
        expect(getPaymentSettlement(db, receiptId)).toEqual({
          receiptId, status: 'pending', nextCheckAt: START,
          attemptCount: 0, updatedAt: START,
        });
        expect(listPaymentSettlementObservations(db, receiptId)).toEqual([]);
      }
      expect(getPaymentSettlement(db, 'x402')).toBeUndefined();
      const receipts = db.query<{receiptId: string; status: string}, []>(
        'SELECT receipt_id AS receiptId, status FROM payment_receipts ORDER BY receipt_id',
      ).all();
      expect(receipts).toEqual([
        {receiptId: 'refunded', status: 'refunded'},
        {receiptId: 'released', status: 'released'},
        {receiptId: 'x402', status: 'delivered'},
      ]);
    } finally {
      db.close();
    }
  });
});

function deliveredReceipt(receiptId = 'delivered'): PaymentReceiptRecord {
  return {
    receiptId,
    idempotencyKey: `${receiptId}-key`,
    payer: 'buyer',
    txHash: 'deposit-hash',
    network: 'cardano-preprod',
    amount: 1_000_000,
    asset: 'lovelace',
    payTo: 'seller',
    resource: 'https://scores.example/score',
    status: 'delivered',
    simulated: true,
    createdAt: START,
    protocolData: '{"paymentId":"masumi-payment"}',
    responseJson: '{"scores":[42]}',
    resultHash: 'result-hash',
    deliveredAt: START,
    updatedAt: START,
  };
}

function observation(
  overrides: Partial<SettlementObservationInput> = {},
): SettlementObservationInput {
  return {
    receiptId: 'delivered', observedAt: START, status: 'funds_locked',
    verified: false, evidenceJson: '{"depositTx":"deposit-hash"}',
    nextCheckAt: CHECK, ...overrides,
  };
}
