/**
 * @fileoverview Durable settlement summaries and append-only observations.
 * These queries never change delivery fields or contact a payment service.
 */

import type {Database} from 'bun:sqlite';
import {flag, readFlag, requireOneOf, requiredRow, requireText} from './codecs';

/** Financial state, independent of the local receipt delivery status. */
export type SettlementStatus = 'pending'|'funds_locked'|'result_queued'|
  'result_confirmed'|'withdrawal_pending'|'withdrawal_available'|'withdrawn'|
  'disputed'|'refund_requested'|'refund_authorized'|'refund_available'|
  'refund_pending'|'refunded'|'disputed_settled'|'expired_unfunded'|
  'recovery_required'|'unknown';

/** The most recent observation and the last independently verified state. */
export interface PaymentSettlementRecord {
  receiptId: string;
  status: SettlementStatus;
  lastVerifiedStatus?: SettlementStatus;
  lastVerifiedAt?: string;
  nextCheckAt: string|null;
  attemptCount: number;
  lastCheckedAt?: string;
  lastError?: string;
  updatedAt: string;
}

/** Evidence and the next check are committed with the summary in one write. */
export interface SettlementObservationInput {
  receiptId: string;
  observedAt: string;
  status: SettlementStatus;
  verified: boolean;
  evidenceJson: string;
  error?: string;
  nextCheckAt: string|null;
}

/** An immutable stored observation. */
export interface SettlementObservationRecord extends SettlementObservationInput {
  id: number;
}

const SETTLEMENT_STATUSES: readonly SettlementStatus[] = [
  'pending', 'funds_locked', 'result_queued', 'result_confirmed',
  'withdrawal_pending', 'withdrawal_available', 'withdrawn', 'disputed',
  'refund_requested', 'refund_authorized', 'refund_available', 'refund_pending',
  'refunded', 'disputed_settled', 'expired_unfunded', 'recovery_required', 'unknown',
];

const SELECT_SETTLEMENT = `SELECT
  receipt_id AS receiptId, status, last_verified_status AS lastVerifiedStatus,
  last_verified_at AS lastVerifiedAt, next_check_at AS nextCheckAt,
  attempt_count AS attemptCount, last_checked_at AS lastCheckedAt,
  last_error AS lastError, updated_at AS updatedAt
  FROM payment_settlements`;

const SELECT_OBSERVATION = `SELECT
  id, receipt_id AS receiptId, observed_at AS observedAt, status, verified,
  evidence_json AS evidenceJson, error, next_check_at AS nextCheckAt
  FROM payment_settlement_observations`;

interface SettlementRow {
  receiptId: string;
  status: string;
  lastVerifiedStatus: string|null;
  lastVerifiedAt: string|null;
  nextCheckAt: string|null;
  attemptCount: number;
  lastCheckedAt: string|null;
  lastError: string|null;
  updatedAt: string;
}

interface ObservationRow {
  id: number;
  receiptId: string;
  observedAt: string;
  status: string;
  verified: number;
  evidenceJson: string;
  error: string|null;
  nextCheckAt: string|null;
}

/** Creates a pending schedule once. Existing evidence and due dates stay intact. */
export function ensurePaymentSettlement(
  db: Database,
  receiptId: string,
  at: string,
): PaymentSettlementRecord {
  const id = requireText(receiptId, 'receiptId');
  const timestamp = requireTimestamp(at, 'at');
  db.query(`INSERT INTO payment_settlements (
    receipt_id, status, next_check_at, updated_at
  ) VALUES (?, 'pending', ?, ?) ON CONFLICT (receipt_id) DO NOTHING`)
    .run(id, timestamp, timestamp);
  return requiredRow(getPaymentSettlement(db, id), `settlement ${id}`);
}

/** Wakes a receipt for an earlier check, including a stopped terminal schedule. */
export function schedulePaymentSettlement(
  db: Database,
  receiptId: string,
  at: string,
): PaymentSettlementRecord {
  const id = requireText(receiptId, 'receiptId');
  const timestamp = requireTimestamp(at, 'at');
  return db.transaction(() => {
    ensurePaymentSettlement(db, id, timestamp);
    db.query(`UPDATE payment_settlements SET next_check_at = ?
      WHERE receipt_id = ? AND (next_check_at IS NULL OR next_check_at > ?)`)
      .run(timestamp, id, timestamp);
    return requiredRow(getPaymentSettlement(db, id), `settlement ${id}`);
  }).immediate();
}

/** Returns a summary, or undefined when the receipt has no settlement record. */
export function getPaymentSettlement(
  db: Database,
  receiptId: string,
): PaymentSettlementRecord|undefined {
  const row = db.query<SettlementRow, [string]>(
    `${SELECT_SETTLEMENT} WHERE receipt_id = ?`,
  ).get(requireText(receiptId, 'receiptId'));
  return row === null ? undefined : readSettlement(row);
}

/** Lists due receipts in due-date order. Null schedules are stopped. */
export function listDuePaymentSettlements(
  db: Database,
  at: string,
  limit = 25,
): PaymentSettlementRecord[] {
  const timestamp = requireTimestamp(at, 'at');
  const count = requireLimit(limit);
  return db.query<SettlementRow, [string, number]>(`${SELECT_SETTLEMENT}
    WHERE next_check_at IS NOT NULL AND next_check_at <= ?
    ORDER BY next_check_at, receipt_id LIMIT ?`)
    .all(timestamp, count).map(readSettlement);
}

/**
 * Saves evidence, summary, and retry schedule atomically. An error keeps the
 * previous financial state. Recovery can reopen a terminal state without
 * erasing the historic verified state. Delivery fields stay unchanged.
 */
export function recordPaymentSettlementObservation(
  db: Database,
  input: SettlementObservationInput,
): PaymentSettlementRecord {
  const receiptId = requireText(input.receiptId, 'receiptId');
  const observedAt = requireTimestamp(input.observedAt, 'observedAt');
  const status = requireOneOf(input.status, SETTLEMENT_STATUSES, 'settlement status');
  const verified = flag(input.verified);
  const evidenceJson = requireEvidenceJson(input.evidenceJson);
  const error = input.error === undefined ? null : requireText(input.error, 'error');
  const nextCheckAt = input.nextCheckAt === null ? null :
    requireTimestamp(input.nextCheckAt, 'nextCheckAt');
  if (error !== null && input.verified) {
    throw new Error('an error observation cannot verify settlement');
  }
  return db.transaction(() => {
    const previous = ensurePaymentSettlement(db, receiptId, observedAt);
    db.query(`INSERT INTO payment_settlement_observations (
      receipt_id, observed_at, status, verified, evidence_json, error, next_check_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(receiptId, observedAt, status, verified, evidenceJson, error, nextCheckAt);
    db.query(`UPDATE payment_settlements SET status = ?,
      last_verified_status = ?, last_verified_at = ?, next_check_at = ?,
      attempt_count = attempt_count + 1, last_checked_at = ?, last_error = ?,
      updated_at = ? WHERE receipt_id = ?`).run(
      error === null ? status : previous.status,
      input.verified ? status : previous.lastVerifiedStatus ?? null,
      input.verified ? observedAt : previous.lastVerifiedAt ?? null,
      nextCheckAt,
      observedAt,
      error,
      observedAt,
      receiptId,
    );
    return requiredRow(getPaymentSettlement(db, receiptId), `settlement ${receiptId}`);
  }).immediate();
}

/** Returns the latest observations in commit order, oldest to newest. */
export function listPaymentSettlementObservations(
  db: Database,
  receiptId: string,
  limit = 100,
): SettlementObservationRecord[] {
  const rows = db.query<ObservationRow, [string, number]>(`${SELECT_OBSERVATION}
    WHERE receipt_id = ?
    ORDER BY id DESC LIMIT ?`)
    .all(requireText(receiptId, 'receiptId'), requireLimit(limit));
  return rows.reverse().map(readObservation);
}

/** Reads the latest verified proof independently of the display history limit. */
export function getLastVerifiedPaymentSettlementObservation(
  db: Database,
  receiptId: string,
  status?: SettlementStatus,
): SettlementObservationRecord|undefined {
  const id = requireText(receiptId, 'receiptId');
  const row = status === undefined ?
    db.query<ObservationRow, [string]>(`${SELECT_OBSERVATION}
      WHERE receipt_id = ? AND verified = 1 ORDER BY id DESC LIMIT 1`).get(id) :
    db.query<ObservationRow, [string, string]>(`${SELECT_OBSERVATION}
      WHERE receipt_id = ? AND verified = 1 AND status = ?
      ORDER BY id DESC LIMIT 1`).get(
      id, requireOneOf(status, SETTLEMENT_STATUSES, 'settlement status'),
    );
  return row === null ? undefined : readObservation(row);
}

function readObservation(row: ObservationRow): SettlementObservationRecord {
  const record: SettlementObservationRecord = {
    id: row.id,
    receiptId: row.receiptId,
    observedAt: row.observedAt,
    status: requireOneOf(row.status, SETTLEMENT_STATUSES, 'settlement status'),
    verified: readFlag(row.verified, 'verified'),
    evidenceJson: row.evidenceJson,
    nextCheckAt: row.nextCheckAt,
  };
  if (row.error !== null) record.error = row.error;
  return record;
}

function readSettlement(row: SettlementRow): PaymentSettlementRecord {
  const record: PaymentSettlementRecord = {
    receiptId: row.receiptId,
    status: requireOneOf(row.status, SETTLEMENT_STATUSES, 'settlement status'),
    nextCheckAt: row.nextCheckAt,
    attemptCount: row.attemptCount,
    updatedAt: row.updatedAt,
  };
  if (row.lastVerifiedStatus !== null) {
    record.lastVerifiedStatus = requireOneOf(
      row.lastVerifiedStatus, SETTLEMENT_STATUSES, 'verified settlement status',
    );
  }
  for (const key of ['lastVerifiedAt', 'lastCheckedAt', 'lastError'] as const) {
    if (row[key] !== null) record[key] = row[key];
  }
  return record;
}

function requireTimestamp(value: string, label: string): string {
  requireText(value, label);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return new Date(milliseconds).toISOString();
}

function requireEvidenceJson(value: string): string {
  requireText(value, 'evidenceJson');
  try {
    JSON.parse(value);
  } catch {
    throw new Error('evidenceJson must contain valid JSON');
  }
  return value;
}

function requireLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error('limit must be a positive integer');
  }
  return value;
}
