/**
 * @fileoverview Offers and accepted fee charges. Schema lives in
 * 016_marketplace_offers_fees.sql.
 */

import type {Database} from 'bun:sqlite';
import type {FeeCharge} from '../../reliability/src/fee-charges';
import type {Offer} from '../../reliability/src/offers';
import {requireText} from './codecs';

/** Inserts a new offer. */
export function insertOffer(db: Database, offer: Offer): void {
  db.query(`INSERT INTO reliability_offers (id, listing_id, buyer_id, seller_id,
      status, transaction_id, offer_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    requireText(offer.id, 'id'), offer.listingId, offer.buyerId, offer.sellerId,
    offer.status, offer.transactionId ?? null, JSON.stringify(offer),
    offer.createdAt, offer.createdAt,
  );
}

/**
 * Replaces an offer only while its stored status is still `open`.
 * Returns false when another writer decided it first.
 */
export function updateOpenOffer(db: Database, offer: Offer, at: string): boolean {
  const result = db.query(`UPDATE reliability_offers
      SET status = ?, transaction_id = ?, offer_json = ?, updated_at = ?
      WHERE id = ? AND status = 'open'`).run(
    offer.status, offer.transactionId ?? null, JSON.stringify(offer), at, offer.id,
  );
  return result.changes === 1;
}

export function getOffer(db: Database, id: string): Offer|undefined {
  const row = db.query<{offerJson: string}, [string]>(
    'SELECT offer_json AS offerJson FROM reliability_offers WHERE id = ?',
  ).get(id);
  return row ? JSON.parse(row.offerJson) as Offer : undefined;
}

/** Lists offers, oldest first. Filters are optional. */
export function listOffers(
  db: Database, filter: {listingId?: string; buyerId?: string; sellerId?: string} = {},
): Offer[] {
  return db.query<{offerJson: string}, [string|null, string|null, string|null]>(
    `SELECT offer_json AS offerJson FROM reliability_offers
     WHERE (?1 IS NULL OR listing_id = ?1) AND (?2 IS NULL OR buyer_id = ?2)
       AND (?3 IS NULL OR seller_id = ?3)
     ORDER BY created_at, id`,
  ).all(filter.listingId ?? null, filter.buyerId ?? null, filter.sellerId ?? null)
    .map((row) => JSON.parse(row.offerJson) as Offer);
}

/** Inserts an accepted charge. A second charge for one sale is an error. */
export function insertFeeCharge(db: Database, charge: FeeCharge): void {
  db.query(`INSERT INTO reliability_fee_charges
      (transaction_id, status, charge_json, accepted_at, settled_at)
      VALUES (?, ?, ?, ?, ?)`).run(
    requireText(charge.transactionId, 'transactionId'), charge.status,
    JSON.stringify(charge), charge.acceptedAt, charge.settledAt ?? null,
  );
}

/** Moves a charge from `fromStatus`. Returns false when another writer moved it first. */
export function settleFeeChargeRow(db: Database, charge: FeeCharge, fromStatus: string): boolean {
  const result = db.query(`UPDATE reliability_fee_charges
      SET status = ?, charge_json = ?, settled_at = ?
      WHERE transaction_id = ? AND status = ?`).run(
    charge.status, JSON.stringify(charge), charge.settledAt ?? null, charge.transactionId, fromStatus,
  );
  return result.changes === 1;
}

export function getFeeCharge(db: Database, transactionId: string): FeeCharge|undefined {
  const row = db.query<{chargeJson: string}, [string]>(
    'SELECT charge_json AS chargeJson FROM reliability_fee_charges WHERE transaction_id = ?',
  ).get(transactionId);
  return row ? JSON.parse(row.chargeJson) as FeeCharge : undefined;
}

/** Stored payment observation for one invoice (migration 009). */
export interface InvoiceSettlementRecord {
  transactionId: string;
  reference: string;
  mode: 'paper'|'live';
  verified: boolean;
  settledAt: string;
  amountMinor: string;
  currency: string;
  recordedAt: string;
}

/** Inserts or replaces the observation for one invoice. A reused reference fails. */
export function saveInvoiceSettlement(db: Database, record: InvoiceSettlementRecord): void {
  db.query(`INSERT INTO reliability_invoice_settlements (transaction_id, reference,
      mode, verified, settled_at, amount_minor, currency, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET reference = excluded.reference,
        mode = excluded.mode, verified = excluded.verified,
        settled_at = excluded.settled_at, amount_minor = excluded.amount_minor,
        currency = excluded.currency, recorded_at = excluded.recorded_at`).run(
    requireText(record.transactionId, 'transactionId'), requireText(record.reference, 'reference'),
    record.mode, record.verified ? 1 : 0, record.settledAt, record.amountMinor,
    record.currency, record.recordedAt,
  );
}

export function getInvoiceSettlement(
  db: Database, transactionId: string,
): InvoiceSettlementRecord|undefined {
  const row = db.query<Omit<InvoiceSettlementRecord, 'verified'> & {verified: number}, [string]>(
    `SELECT transaction_id AS transactionId, reference, mode, verified,
       settled_at AS settledAt, amount_minor AS amountMinor, currency,
       recorded_at AS recordedAt
     FROM reliability_invoice_settlements WHERE transaction_id = ?`,
  ).get(transactionId);
  return row ? {...row, verified: row.verified === 1} : undefined;
}

/** Invoice that already used a payment reference, if any. */
export function invoiceForSettlementReference(db: Database, reference: string): string|undefined {
  return db.query<{transactionId: string}, [string]>(
    'SELECT transaction_id AS transactionId FROM reliability_invoice_settlements WHERE reference = ?',
  ).get(reference)?.transactionId;
}
