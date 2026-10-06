/** @fileoverview Durable paper deposits and allocations on the shared store. */

import type {Database} from 'bun:sqlite';
import {randomUUID} from 'node:crypto';
import type {
  DealFundingRequest, OmnibusBalance, PaperDealFundingRecord,
  PaperOmnibusPool, PaperPoolDeposit,
} from '../../reliability/src/omnibus-funding';
import {requireAmount, requireText, requiredRow} from './codecs';

function positiveAmount(value: number): number {
  requireAmount(value);
  if (value === 0) throw new Error('amount must be positive');
  return value;
}

function paperAddress(value: string, kind: 'pool'|'business'): string {
  requireText(value, `${kind} address`);
  if (!value.startsWith(`paper:${kind}:`) || value === `paper:${kind}:`) {
    throw new Error(`${kind} address must be a paper placeholder`);
  }
  return value;
}

function timestamp(value: string): string {
  requireText(value, 'at');
  if (!Number.isFinite(Date.parse(value))) throw new Error('at must be a timestamp');
  return value;
}

function getPool(db: Database, poolId: string): PaperOmnibusPool|undefined {
  return db.query<PaperOmnibusPool, [string]>(`SELECT
      pool_id AS poolId, pool_address AS poolAddress
      FROM reliability_omnibus_pools WHERE pool_id = ?`).get(poolId) ?? undefined;
}

/** A pool address cannot change after its first use. */
export function ensurePaperOmnibusPool(
  db: Database, pool: PaperOmnibusPool,
): PaperOmnibusPool {
  requireText(pool.poolId, 'poolId');
  paperAddress(pool.poolAddress, 'pool');
  return db.transaction(() => {
    const saved = getPool(db, pool.poolId);
    if (saved) {
      if (saved.poolAddress !== pool.poolAddress) {
        throw new Error('pool address cannot change');
      }
      return saved;
    }
    db.query(`INSERT INTO reliability_omnibus_pools (pool_id, pool_address)
        VALUES (?, ?)`).run(pool.poolId, pool.poolAddress);
    return {...pool};
  }).immediate();
}

function getDeposit(db: Database, key: string): PaperPoolDeposit|undefined {
  return db.query<PaperPoolDeposit, [string]>(`SELECT
      idempotency_key AS idempotencyKey, pool_id AS poolId,
      business_id AS businessId, source_address AS sourceAddress,
      deposit_tx_hash AS depositTxHash, output_index AS outputIndex,
      amount_lovelace AS amountLovelace, at
      FROM reliability_omnibus_deposits WHERE idempotency_key = ?`).get(key)
    ?? undefined;
}

/** Exact retries return the original credit. A chain output is credited once. */
export function recordPaperPoolDeposit(
  db: Database, deposit: PaperPoolDeposit,
): PaperPoolDeposit {
  requireText(deposit.idempotencyKey, 'idempotencyKey');
  requireText(deposit.poolId, 'poolId');
  requireText(deposit.businessId, 'businessId');
  requireText(deposit.depositTxHash, 'depositTxHash');
  paperAddress(deposit.sourceAddress, 'business');
  requireAmount(deposit.outputIndex);
  positiveAmount(deposit.amountLovelace);
  timestamp(deposit.at);
  return db.transaction(() => {
    const saved = getDeposit(db, deposit.idempotencyKey);
    if (saved) {
      if (saved.poolId !== deposit.poolId ||
          saved.businessId !== deposit.businessId ||
          saved.sourceAddress !== deposit.sourceAddress ||
          saved.depositTxHash !== deposit.depositTxHash ||
          saved.outputIndex !== deposit.outputIndex ||
          saved.amountLovelace !== deposit.amountLovelace) {
        throw new Error('deposit idempotency key conflicts with saved credit');
      }
      return saved;
    }
    db.query(`INSERT INTO reliability_omnibus_deposits
        (idempotency_key, pool_id, business_id, source_address,
         deposit_tx_hash, output_index, amount_lovelace, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      deposit.idempotencyKey, deposit.poolId, deposit.businessId,
      deposit.sourceAddress, deposit.depositTxHash, deposit.outputIndex,
      deposit.amountLovelace, deposit.at,
    );
    // Reject unsafe totals before the credit commits.
    getOmnibusBalance(db, deposit.poolId, deposit.businessId);
    return requiredRow(getDeposit(db, deposit.idempotencyKey), 'deposit');
  }).immediate();
}

/** Balances come from immutable credits and allocations. They are not wallets. */
export function getOmnibusBalance(
  db: Database, poolId: string, businessId: string,
): OmnibusBalance {
  requireText(poolId, 'poolId');
  requireText(businessId, 'businessId');
  const row = db.query<OmnibusBalance, [string, string, string, string]>(`SELECT
      (SELECT COALESCE(SUM(amount_lovelace), 0)
       FROM reliability_omnibus_deposits WHERE pool_id = ? AND business_id = ?)
        AS depositedLovelace,
      (SELECT COALESCE(SUM(amount_lovelace), 0)
       FROM reliability_omnibus_deal_funding WHERE pool_id = ? AND business_id = ?)
        AS allocatedLovelace`).get(poolId, businessId, poolId, businessId);
  if (!row) throw new Error('balance query failed');
  requireAmount(row.depositedLovelace);
  requireAmount(row.allocatedLovelace);
  return {
    depositedLovelace: row.depositedLovelace,
    allocatedLovelace: row.allocatedLovelace,
    availableLovelace: requireAmount(row.depositedLovelace - row.allocatedLovelace),
  };
}

function getFunding(db: Database, key: string): PaperDealFundingRecord|undefined {
  return db.query<PaperDealFundingRecord, [string]>(`SELECT
      f.idempotency_key AS idempotencyKey, f.pool_id AS poolId,
      p.pool_address AS poolAddress, f.business_id AS businessId,
      f.transaction_id AS transactionId, f.deal_address AS dealAddress,
      f.tx_hash AS txHash, f.amount_lovelace AS amountLovelace, f.at
      FROM reliability_omnibus_deal_funding f
      JOIN reliability_omnibus_pools p ON p.pool_id = f.pool_id
      WHERE f.idempotency_key = ?`).get(key) ?? undefined;
}

/** Allocates paper funds and creates one opaque deal address atomically. */
export function fundPaperDeal(
  db: Database, request: DealFundingRequest & {poolId: string},
): PaperDealFundingRecord {
  requireText(request.idempotencyKey, 'idempotencyKey');
  requireText(request.poolId, 'poolId');
  requireText(request.businessId, 'businessId');
  requireText(request.transactionId, 'transactionId');
  positiveAmount(request.amountLovelace);
  timestamp(request.at);
  return db.transaction(() => {
    const saved = getFunding(db, request.idempotencyKey);
    if (saved) {
      if (saved.poolId !== request.poolId ||
          saved.businessId !== request.businessId ||
          saved.transactionId !== request.transactionId ||
          saved.amountLovelace !== request.amountLovelace) {
        throw new Error('funding idempotency key conflicts with saved allocation');
      }
      return saved;
    }
    const pool = requiredRow(getPool(db, request.poolId), 'pool');
    const deal = db.query<{buyerId: string; completedAt: string|null}, [string]>(
      `SELECT buyer_id AS buyerId, completed_at AS completedAt
       FROM reliability_transactions WHERE id = ?`,
    ).get(request.transactionId);
    if (!deal || deal.buyerId !== request.businessId) {
      throw new Error('business must be the deal buyer');
    }
    if (deal.completedAt !== null) throw new Error('deal is already completed');
    const balance = getOmnibusBalance(db, request.poolId, request.businessId);
    if (balance.availableLovelace < request.amountLovelace) {
      throw new Error('insufficient business balance in pool');
    }
    // Random references do not encode a business id or transaction id.
    const dealAddress = `paper:deal:${randomUUID()}`;
    const txHash = `paper:${randomUUID()}`;
    db.query(`INSERT INTO reliability_omnibus_deal_funding
        (idempotency_key, pool_id, business_id, transaction_id,
         deal_address, tx_hash, amount_lovelace, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      request.idempotencyKey, request.poolId, request.businessId,
      request.transactionId, dealAddress, txHash, request.amountLovelace, request.at,
    );
    return {...request, poolAddress: pool.poolAddress, dealAddress, txHash};
  }).immediate();
}
