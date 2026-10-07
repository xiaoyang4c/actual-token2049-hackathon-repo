/**
 * @fileoverview Event weights and repeat-pair membership for the math lane.
 * Schema lives in 007_reliability_weights.sql.
 */

import type {Database} from 'bun:sqlite';
import type {EventWeightRecord} from '../../reliability/src/event-weights';
import type {WeightReason} from '../../reliability/src/scoring';
import type {EntityRole, ReliabilityCategory} from '../../reliability/src/types';
import {flag, readFlag, requireText} from './codecs';

interface WeightRow {
  eventId: string;
  transactionId: string;
  entityId: string;
  category: string;
  role: string;
  inputsKey: string;
  eligible: number;
  normalizedValue: number|null;
  valueScale: number;
  valueWeight: number;
  pairKey: string|null;
  pairCount: number;
  pairFactor: number;
  weight: number;
  reason: string;
  scoringVersion: string;
  decayVersion: string;
  computedAt: string;
}

const WEIGHT_COLUMNS = `event_id AS eventId, transaction_id AS transactionId,
  entity_id AS entityId, category, role, inputs_key AS inputsKey, eligible,
  normalized_value AS normalizedValue, value_scale AS valueScale,
  value_weight AS valueWeight, pair_key AS pairKey, pair_count AS pairCount,
  pair_factor AS pairFactor, weight, reason, scoring_version AS scoringVersion,
  decay_version AS decayVersion, computed_at AS computedAt`;

function fromRow(row: WeightRow): EventWeightRecord {
  return {
    ...row,
    category: row.category as ReliabilityCategory,
    role: row.role as EntityRole,
    eligible: readFlag(row.eligible, 'eligible'),
    reason: row.reason as WeightReason,
  };
}

/** Inserts or replaces the weight of one event. */
export function saveEventWeight(db: Database, record: EventWeightRecord): void {
  db.query(`INSERT INTO reliability_event_weights (event_id, transaction_id,
      entity_id, category, role, inputs_key, eligible, normalized_value,
      value_scale, value_weight, pair_key, pair_count, pair_factor, weight,
      reason, scoring_version, decay_version, computed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        transaction_id = excluded.transaction_id, entity_id = excluded.entity_id,
        category = excluded.category, role = excluded.role,
        inputs_key = excluded.inputs_key, eligible = excluded.eligible,
        normalized_value = excluded.normalized_value,
        value_scale = excluded.value_scale, value_weight = excluded.value_weight,
        pair_key = excluded.pair_key, pair_count = excluded.pair_count,
        pair_factor = excluded.pair_factor, weight = excluded.weight,
        reason = excluded.reason, scoring_version = excluded.scoring_version,
        decay_version = excluded.decay_version, computed_at = excluded.computed_at`).run(
    requireText(record.eventId, 'eventId'), requireText(record.transactionId, 'transactionId'),
    requireText(record.entityId, 'entityId'), record.category, record.role,
    record.inputsKey, flag(record.eligible), record.normalizedValue, record.valueScale,
    record.valueWeight, record.pairKey, record.pairCount, record.pairFactor,
    record.weight, record.reason, record.scoringVersion, record.decayVersion,
    requireText(record.computedAt, 'computedAt'),
  );
}

/** Reads the weight of one event. */
export function getEventWeight(db: Database, eventId: string): EventWeightRecord|undefined {
  const row = db.query<WeightRow, [string]>(
    `SELECT ${WEIGHT_COLUMNS} FROM reliability_event_weights WHERE event_id = ?`,
  ).get(eventId);
  return row ? fromRow(row) : undefined;
}

/** Lists the weights recorded for one transaction. */
export function listEventWeightsForTransaction(
  db: Database, transactionId: string,
): EventWeightRecord[] {
  return db.query<WeightRow, [string]>(
    `SELECT ${WEIGHT_COLUMNS} FROM reliability_event_weights
     WHERE transaction_id = ? ORDER BY event_id`,
  ).all(transactionId).map(fromRow);
}

/** Position of a transaction inside a pair, or undefined. */
export function getPairPosition(
  db: Database, pairKey: string, transactionId: string,
): number|undefined {
  const row = db.query<{position: number}, [string, string]>(
    `SELECT position FROM reliability_pair_transactions
     WHERE pair_key = ? AND transaction_id = ?`,
  ).get(pairKey, transactionId);
  return row?.position;
}

/**
 * Adds a transaction to a pair at the next position and returns that
 * position. A second call for the same transaction returns the first one.
 */
export function addPairTransaction(
  db: Database, pairKey: string, transactionId: string, at: string,
): number {
  const existing = getPairPosition(db, pairKey, transactionId);
  if (existing !== undefined) return existing;
  const row = db.query<{count: number}, [string]>(
    'SELECT COUNT(*) AS count FROM reliability_pair_transactions WHERE pair_key = ?',
  ).get(pairKey);
  const position = row?.count ?? 0;
  db.query(`INSERT INTO reliability_pair_transactions
      (pair_key, transaction_id, position, recorded_at) VALUES (?, ?, ?, ?)`).run(
    pairKey, requireText(transactionId, 'transactionId'), position, requireText(at, 'at'),
  );
  return position;
}

/**
 * Removes a transaction from every pair and moves later transactions down
 * one position. Returns the transactions whose position changed.
 */
export function removePairTransaction(db: Database, transactionId: string): string[] {
  const memberships = db.query<{pairKey: string; position: number}, [string]>(
    `SELECT pair_key AS pairKey, position FROM reliability_pair_transactions
     WHERE transaction_id = ?`,
  ).all(transactionId);
  const moved: string[] = [];
  for (const membership of memberships) {
    db.query('DELETE FROM reliability_pair_transactions WHERE pair_key = ? AND transaction_id = ?')
      .run(membership.pairKey, transactionId);
    const later = db.query<{transactionId: string}, [string, number]>(
      `SELECT transaction_id AS transactionId FROM reliability_pair_transactions
       WHERE pair_key = ? AND position > ? ORDER BY position`,
    ).all(membership.pairKey, membership.position);
    db.query(`UPDATE reliability_pair_transactions SET position = position - 1
      WHERE pair_key = ? AND position > ?`).run(membership.pairKey, membership.position);
    moved.push(...later.map((row) => row.transactionId));
  }
  return moved;
}

/** Deletes every weight and pair row. A full score rebuild starts here. */
export function clearScoreWeights(db: Database): void {
  db.run('DELETE FROM reliability_event_weights');
  db.run('DELETE FROM reliability_pair_transactions');
}
