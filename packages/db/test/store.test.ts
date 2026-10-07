/**
 * @fileoverview Schema creation and one-row round trips for each table.
 */

import {Database} from 'bun:sqlite';
import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import type {Policy} from '../../core/src/types';
import {
  AgentStore,
  applyMigrations,
  type OrderRecord,
  type PaymentReceiptRecord,
  type RunRecord,
} from '../src/index';

const CREATED_AT = '2026-10-03T00:00:00.000Z';
const CYCLE_ID = 'cycle-2026-10-03T00:00:00.000Z';

const POLICY: Policy = {
  max_bet: 25,
  max_daily_loss: 100,
  category_allow: [],
  category_deny: ['politics'],
  venues_enabled: ['polymarket', 'kalshi'],
  stop_loss_pct: 0.2,
  kill_switch: false,
};

describe('AgentStore', () => {
  test('migrates an existing legacy receipt without losing its history', () => {
    const db = new Database(':memory:');
    try {
      db.run(readFileSync(new URL('../migrations/001_initial.sql', import.meta.url), 'utf8'));
      db.run(`CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
      )`);
      db.run("INSERT INTO schema_migrations VALUES (1, '001_initial.sql', '2026-10-03')");
      db.run(`INSERT INTO payment_receipts (
        receipt_id, idempotency_key, payer, tx_hash, network, amount, asset,
        pay_to, resource, status, simulated, created_at
      ) VALUES ('legacy', 'legacy-key', 'payer', 'legacy-hash', 'cardano-preprod',
        1000000, 'lovelace', 'payee', 'resource', 'released', 1, '2026-10-03')`);
      applyMigrations(db);
      applyMigrations(db);
      const saved = db.query<{status: string; txHash: string; resultHash: string|null}, []>(
        'SELECT status, tx_hash AS txHash, result_hash AS resultHash FROM payment_receipts',
      ).get();
      expect(saved).toEqual({status: 'released', txHash: 'legacy-hash', resultHash: null});
      expect(db.query<{count: number}, []>('SELECT COUNT(*) AS count FROM payment_receipts').get()?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  test('creates the runtime tables', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations(db);
      applyMigrations(db);
      const rows = db
        .query<{name: string}, [string]>(
          `SELECT name
           FROM sqlite_master
           WHERE type = ?
           ORDER BY name`,
        )
        .all('table');
      expect(rows.map((row) => row.name)).toEqual([
        'agent_state',
        'audit_events',
        'contract_actions',
        'contract_audit',
        'contract_contracts',
        'contract_evidence',
        'contract_evidence_content',
        'contract_operations',
        'contract_paper_clock',
        'contract_paper_escrow_ops',
        'contract_paper_escrows',
        'contract_parties',
        'contract_publications',
        'daily_summaries',
        'market_quotes',
        'market_resolutions',
        'orders',
        'payment_receipts',
        'payment_settlement_observations',
        'payment_settlements',
        'policy',
        'position_events',
        'reliability_anchor_batches',
        'reliability_anchor_entries',
        'reliability_deposit_submissions',
        'reliability_entities',
        'reliability_event_revisions',
        'reliability_event_weights',
        'reliability_events',
        'reliability_fee_charges',
        'reliability_invoice_settlements',
        'reliability_kyc_identifiers',
        'reliability_kyc_profiles',
        'reliability_kyc_status_records',
        'reliability_lifecycle_commands',
        'reliability_lifecycle_transitions',
        'reliability_listings',
        'reliability_live_deposits',
        'reliability_offers',
        'reliability_omnibus_deal_funding',
        'reliability_omnibus_deposits',
        'reliability_omnibus_pools',
        'reliability_outcomes',
        'reliability_pair_transactions',
        'reliability_score_baselines',
        'reliability_sessions',
        'reliability_state',
        'reliability_terms_decisions',
        'reliability_terms_versions',
        'reliability_transactions',
        'reliability_wallet_challenges',
        'reliability_wallet_proofs',
        'reliability_wallets',
        'runs',
        'schema_migrations',
      ]);
      const versions = db
        .query<{versions: number}, []>(
          'SELECT COUNT(*) AS versions FROM schema_migrations',
        )
        .get();
      expect(versions).not.toBeNull();
      if (versions === null) {
        return;
      }
      // 001-017.
      expect(versions.versions).toBe(17);
    } finally {
      db.close();
    }
  });

  test('round-trips policy, run, order, audit, and receipt records', () => {
    const store = AgentStore.open();
    try {
      const policy = store.insertPolicy({
        createdAt: CREATED_AT,
        policy: POLICY,
      });
      expect(policy.policy).toEqual(POLICY);
      expect(store.getPolicy(policy.id)).toEqual(policy);
      expect(store.getPolicy(0)).toBeUndefined();

      const run: RunRecord = {
        id: CYCLE_ID,
        policyId: policy.id,
        startedAt: CREATED_AT,
        finishedAt: '2026-10-03T00:00:01.000Z',
        status: 'completed',
        summary: '1 proposed, 1 approved, 1 filled (paper)',
        cash: 990,
        equity: 1000,
        startOfDayEquity: 1000,
        highWaterMark: 1000,
        dailyPnl: 0,
        positions: [{
          venue: 'polymarket',
          marketId: 'm1',
          side: 'yes',
          size: 20,
          avgPrice: 0.5,
        }],
      };
      expect(store.insertRun(run)).toEqual(run);
      expect(store.getRun(run.id)).toEqual(run);

      const order: OrderRecord = {
        idempotencyKey: `${CYCLE_ID}:order:0`,
        cycleId: run.id,
        venue: 'polymarket',
        marketId: 'm1',
        side: 'yes',
        size: 20,
        limitPrice: 0.5,
        price: 0.5,
        status: 'filled',
        mode: 'paper',
        reason: 'edge',
        createdAt: '2026-10-03T00:00:01.000Z',
      };
      expect(store.insertOrder(order)).toEqual(order);
      expect(store.getOrder(order.idempotencyKey)).toEqual(order);

      const event = store.insertAuditEvent({
        cycleId: run.id,
        receivedAt: '2026-10-03T00:00:02.000Z',
        type: 'cardano_payment',
        detail: 'receipt rcpt_demo, tx deadbeef (escrowed)',
      });
      expect(store.getAuditEvent(event.id)).toEqual(event);
      expect(event.type).toBe('cardano_payment');

      const receipt: PaymentReceiptRecord = {
        receiptId: 'rcpt_demo',
        idempotencyKey: `${CYCLE_ID}:score`,
        payer: 'addr_test1qz_demo_agent_wallet',
        txHash: 'deadbeef',
        network: 'cardano-preprod',
        amount: 1_000_000,
        asset: 'lovelace',
        payTo: 'addr_test1qz_score_provider',
        resource: 'https://scores.example/score',
        status: 'escrowed',
        simulated: true,
        cycleId: run.id,
        orderKey: order.idempotencyKey,
        createdAt: '2026-10-03T00:00:01.500Z',
      };
      expect(store.insertPaymentReceipt(receipt)).toEqual(receipt);
      const stored = store.getPaymentReceipt(receipt.receiptId);
      expect(stored).toEqual(receipt);
    } finally {
      store.close();
    }
  });

  test('rejects an order whose cycle was not stored', () => {
    const store = AgentStore.open();
    try {
      const order: OrderRecord = {
        idempotencyKey: 'missing:order:0',
        cycleId: 'missing-cycle',
        venue: 'kalshi',
        marketId: 'm2',
        side: 'no',
        size: 1,
        limitPrice: 0.4,
        price: 0.4,
        status: 'rejected',
        mode: 'live',
        reason: 'insufficient_cash',
        createdAt: CREATED_AT,
      };
      expect(() => {
        store.insertOrder(order);
      }).toThrow('FOREIGN KEY constraint failed');
    } finally {
      store.close();
    }
  });

  test('returns the stored order for a repeated idempotency key', () => {
    const store = AgentStore.open();
    try {
      store.insertRun(emptyRun());
      const order: OrderRecord = {
        idempotencyKey: `${CYCLE_ID}:order:0`,
        cycleId: CYCLE_ID,
        venue: 'polymarket',
        marketId: 'm1',
        side: 'yes',
        size: 20,
        limitPrice: 0.5,
        price: 0.5,
        status: 'filled',
        mode: 'paper',
        reason: 'edge',
        createdAt: CREATED_AT,
      };
      expect(store.insertOrder(order)).toEqual(order);
      expect(store.insertOrder({...order, size: 99, status: 'rejected'}))
        .toEqual(order);
      expect(store.getOrder(order.idempotencyKey)).toEqual(order);
    } finally {
      store.close();
    }
  });

  test('rejects a run with a NaN or Infinity position', () => {
    const store = AgentStore.open();
    try {
      const position = {
        venue: 'polymarket' as const,
        marketId: 'm1',
        side: 'yes' as const,
        size: 20,
        avgPrice: 0.5,
      };
      expect(() => {
        store.insertRun({...emptyRun(), positions: [{...position, size: NaN}]});
      }).toThrow('positions contain a non-position');
      expect(() => {
        store.insertRun({
          ...emptyRun(),
          positions: [{...position, avgPrice: Infinity}],
        });
      }).toThrow('positions contain a non-position');
      expect(store.getRun(CYCLE_ID)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});

function emptyRun(): RunRecord {
  return {
    id: CYCLE_ID,
    startedAt: CREATED_AT,
    status: 'running',
    summary: '',
    cash: 1000,
    equity: 1000,
    startOfDayEquity: 1000,
    highWaterMark: 1000,
    dailyPnl: 0,
    positions: [],
  };
}
