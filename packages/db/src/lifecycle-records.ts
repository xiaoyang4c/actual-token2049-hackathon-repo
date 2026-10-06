/**
 * @fileoverview Lifecycle history for lane A.
 * Outcomes and terms versions stay in the reliability query module.
 * This module stores the stage history and the current terms pointer.
 * Schema lives in 010_lane_a_lifecycle.sql. KYC uses migration 008.
 */

import type {Database} from 'bun:sqlite';
import type {JsonValue} from '../../reliability/src/types';
import {jsonText, requireText} from './codecs';

/** One stored stage change. Field names match the lifecycle store seam. */
export interface LifecycleTransitionRecord {
  transactionId: string;
  fromStage: string|null;
  toStage: string;
  evidenceJson: string;
  at: string;
}

/** Appends one stage change. Rows stay in insert order. */
export function insertLifecycleTransition(
  db: Database, record: LifecycleTransitionRecord,
): void {
  db.query(`INSERT INTO reliability_lifecycle_transitions
      (transaction_id, from_stage, to_stage, evidence_json, at)
      VALUES (?, ?, ?, ?, ?)`).run(
    requireText(record.transactionId, 'transactionId'),
    record.fromStage,
    requireText(record.toStage, 'toStage'),
    requireText(record.evidenceJson, 'evidenceJson'),
    requireText(record.at, 'at'),
  );
}

/** Lists stage changes for one transaction, oldest first. */
export function listLifecycleTransitions(
  db: Database, transactionId: string,
): LifecycleTransitionRecord[] {
  return db.query<LifecycleTransitionRecord, [string]>(`SELECT
      transaction_id AS transactionId, from_stage AS fromStage,
      to_stage AS toStage, evidence_json AS evidenceJson, at
      FROM reliability_lifecycle_transitions
      WHERE transaction_id = ? ORDER BY id`).all(
    requireText(transactionId, 'transactionId'),
  );
}

/**
 * Points the transaction at a new terms object.
 * Pass `undefined` for `termsHash` to clear a hash that no longer matches.
 * Callers append a terms version before this update. This write does not
 * edit older version rows.
 */
export function updateTransactionTerms(
  db: Database,
  transactionId: string,
  terms: {[key: string]: JsonValue},
  termsHash: string|undefined,
): void {
  const result = db.query(`UPDATE reliability_transactions
      SET terms_json = ?, terms_hash = ? WHERE id = ?`).run(
    jsonText(terms),
    termsHash ?? null,
    requireText(transactionId, 'transactionId'),
  );
  if (result.changes !== 1) {
    throw new Error('transaction was not stored');
  }
}

/** Records the time a transaction reached a terminal outcome. */
export function setTransactionCompletedAt(
  db: Database, transactionId: string, completedAt: string,
): void {
  const result = db.query(`UPDATE reliability_transactions
      SET completed_at = ? WHERE id = ?`).run(
    requireText(completedAt, 'completedAt'),
    requireText(transactionId, 'transactionId'),
  );
  if (result.changes !== 1) {
    throw new Error('transaction was not stored');
  }
}
