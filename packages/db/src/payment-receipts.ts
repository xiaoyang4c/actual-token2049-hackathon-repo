/**
 * @fileoverview Queries and row conversion for durable payment receipts.
 */

import type {Database} from 'bun:sqlite';
import type {PaymentReceiptRecord, ReceiptStatus} from './records';
import {
  bindOptionalText, flag, readFlag, requireAmount, requireOneOf, requiredRow,
  requireString, requireText,
} from './codecs';

const RECEIPT_STATUSES: readonly ReceiptStatus[] = [
  'requested',
  'submitted',
  'confirmed',
  'delivered',
  'refund_requested',
  'escrowed',
  'released',
  'refunded',
];

const INSERT_RECEIPT = `
  INSERT INTO payment_receipts (
    receipt_id,
    idempotency_key,
    payer,
    tx_hash,
    network,
    amount,
    asset,
    pay_to,
    resource,
    status,
    simulated,
    cycle_id,
    order_key,
    created_at,
    input_hash,
    protocol_data,
    response_json,
    result_hash,
    confirmed_at,
    delivered_at,
    updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const SELECT_RECEIPT = `
  SELECT
    receipt_id AS receiptId,
    idempotency_key AS idempotencyKey,
    payer,
    tx_hash AS txHash,
    network,
    amount,
    asset,
    pay_to AS payTo,
    resource,
    status,
    simulated,
    cycle_id AS cycleId,
    order_key AS orderKey,
    created_at AS createdAt,
    input_hash AS inputHash,
    protocol_data AS protocolData,
    response_json AS responseJson,
    result_hash AS resultHash,
    confirmed_at AS confirmedAt,
    delivered_at AS deliveredAt,
    updated_at AS updatedAt
  FROM payment_receipts
  WHERE receipt_id = ?`;

interface ReceiptRow {
  receiptId: string;
  idempotencyKey: string;
  payer: string;
  txHash: string;
  network: string;
  amount: number;
  asset: string;
  payTo: string;
  resource: string;
  status: string;
  simulated: number;
  cycleId: string|null;
  orderKey: string|null;
  createdAt: string;
  inputHash: string|null;
  protocolData: string|null;
  responseJson: string|null;
  resultHash: string|null;
  confirmedAt: string|null;
  deliveredAt: string|null;
  updatedAt: string|null;
}

/**
 * Inserts an x402 or Masumi receipt. Payer, amount, transaction hash,
 * receipt id, and status are stored as given. The optional cycle and
 * order links are foreign keys, not network calls.
 */
export function insertPaymentReceipt(
  db: Database,
  record: PaymentReceiptRecord,
): PaymentReceiptRecord {
  const receiptId = requireText(record.receiptId, 'receiptId');
  db.query(INSERT_RECEIPT).run(
    receiptId,
    requireText(record.idempotencyKey, 'idempotencyKey'),
    requireText(record.payer, 'payer'),
    requireString(record.txHash, 'txHash'),
    requireText(record.network, 'network'),
    requireAmount(record.amount),
    requireText(record.asset, 'asset'),
    requireText(record.payTo, 'payTo'),
    requireText(record.resource, 'resource'),
    requireOneOf(record.status, RECEIPT_STATUSES, 'receipt status'),
    flag(record.simulated),
    bindOptionalText(record.cycleId),
    bindOptionalText(record.orderKey),
    requireText(record.createdAt, 'createdAt'),
    bindOptionalText(record.inputHash),
    bindOptionalText(record.protocolData),
    bindOptionalText(record.responseJson),
    bindOptionalText(record.resultHash),
    bindOptionalText(record.confirmedAt),
    bindOptionalText(record.deliveredAt),
    bindOptionalText(record.updatedAt),
  );
  return requiredRow(
    selectReceipt(db, receiptId),
    `receipt ${receiptId}`,
  );
}

/** Returns the receipt, or undefined when `receiptId` is absent. */
export function getPaymentReceipt(
  db: Database,
  receiptId: string,
): PaymentReceiptRecord|undefined {
  return selectReceipt(db, receiptId);
}

/** Finds a payment across service restarts. */
export function getPaymentReceiptByKey(
  db: Database,
  key: string,
): PaymentReceiptRecord|undefined {
  const row = db.query<{receiptId: string}, [string]>(
    'SELECT receipt_id AS receiptId FROM payment_receipts WHERE idempotency_key = ?',
  ).get(key);
  return row ? getPaymentReceipt(db, row.receiptId) : undefined;
}

/** Lists receipts in creation order. */
export function listPaymentReceipts(db: Database): PaymentReceiptRecord[] {
  return db.query<{receiptId: string}, []>(
    'SELECT receipt_id AS receiptId FROM payment_receipts ORDER BY created_at, receipt_id',
  ).all().map((row) => requiredRow(getPaymentReceipt(db, row.receiptId), 'receipt'));
}

/** Updates lifecycle fields in one durable write. Payment terms stay fixed. */
export function updatePaymentReceipt(
  db: Database,
  record: PaymentReceiptRecord,
): PaymentReceiptRecord {
  const receiptId = requireText(record.receiptId, 'receiptId');
  db.query(`UPDATE payment_receipts SET
      tx_hash = ?, status = ?, input_hash = ?, protocol_data = ?,
      response_json = ?, result_hash = ?, confirmed_at = ?, delivered_at = ?,
      updated_at = ? WHERE receipt_id = ?`).run(
    requireString(record.txHash, 'txHash'),
    requireOneOf(record.status, RECEIPT_STATUSES, 'receipt status'),
    bindOptionalText(record.inputHash),
    bindOptionalText(record.protocolData),
    bindOptionalText(record.responseJson),
    bindOptionalText(record.resultHash),
    bindOptionalText(record.confirmedAt),
    bindOptionalText(record.deliveredAt),
    bindOptionalText(record.updatedAt),
    receiptId,
  );
  return requiredRow(getPaymentReceipt(db, receiptId), `receipt ${receiptId}`);
}

function selectReceipt(
  db: Database,
  receiptId: string,
): PaymentReceiptRecord|undefined {
  const row = db.query<ReceiptRow, [string]>(SELECT_RECEIPT).get(receiptId);
  if (row === null) {
    return undefined;
  }
  const record: PaymentReceiptRecord = {
    receiptId: row.receiptId,
    idempotencyKey: row.idempotencyKey,
    payer: row.payer,
    txHash: row.txHash,
    network: row.network,
    amount: row.amount,
    asset: row.asset,
    payTo: row.payTo,
    resource: row.resource,
    status: requireOneOf(row.status, RECEIPT_STATUSES, 'receipt status'),
    simulated: readFlag(row.simulated, 'simulated'),
    createdAt: row.createdAt,
  };
  if (row.cycleId !== null) {
    record.cycleId = row.cycleId;
  }
  if (row.orderKey !== null) {
    record.orderKey = row.orderKey;
  }
  for (const key of ['inputHash', 'protocolData', 'responseJson', 'resultHash',
    'confirmedAt', 'deliveredAt', 'updatedAt'] as const) {
    if (row[key] !== null) record[key] = row[key];
  }
  return record;
}
