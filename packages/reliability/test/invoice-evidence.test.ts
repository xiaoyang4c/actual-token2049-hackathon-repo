/**
 * @fileoverview Invoice payment evidence against the agreed terms hash.
 */

import {describe, expect, test} from 'bun:test';
import {
  INVOICE_TERMS_SCHEMA, InvoiceEvidenceError, invoiceOutcome, invoiceTermsHash,
  type InvoiceSettlement, type InvoiceTerms,
} from '../src/evidence-payment';

const TERMS: InvoiceTerms = {
  schema: INVOICE_TERMS_SCHEMA, invoiceNumber: 'INV-1', buyerId: 'buyer', sellerId: 'seller',
  amountMinor: '100000', currency: 'USD', decimals: 2,
  issuedAt: '2026-10-01T00:00:00.000Z', dueDate: '2026-10-08T00:00:00.000Z', graceHours: 24,
};
const HASH = invoiceTermsHash(TERMS);

function paid(settledAt: string, amountMinor = '100000', extra: Partial<InvoiceSettlement> = {}): InvoiceSettlement {
  return {reference: 'pay-1', settledAt, amountMinor, currency: 'USD', verified: false, mode: 'paper', ...extra};
}

function outcome(settlement?: InvoiceSettlement, now = '2026-10-05T00:00:00.000Z', termsHash = HASH) {
  return invoiceOutcome({transactionId: 'inv', terms: TERMS, termsHash, settlement, now});
}

describe('invoice evidence', () => {
  test('hashes canonical terms, independent of key order', () => {
    const reordered = Object.fromEntries(Object.entries(TERMS).reverse()) as unknown as InvoiceTerms;
    expect(invoiceTermsHash(reordered)).toBe(HASH);
    expect(invoiceTermsHash({...TERMS, dueDate: '2026-10-09T00:00:00.000Z'})).not.toBe(HASH);
  });

  test('refuses terms that do not match the agreed hash', () => {
    expect(() => outcome(paid('2026-10-07T00:00:00.000Z'), undefined, 'f'.repeat(64)))
      .toThrow(InvoiceEvidenceError);
  });

  test('a full payment by the due date plus grace succeeds at the payment time', () => {
    const result = outcome(paid('2026-10-08T23:00:00.000Z'));
    expect(result).toMatchObject({
      state: 'successful', verificationMethod: 'payment-settlement', decidedAt: '2026-10-08T23:00:00.000Z',
    });
    expect(result.fault).toBeUndefined();
    expect(result.evidence).toMatchObject({onTime: true, fullAmount: true, settlementVerified: false, mode: 'paper'});
  });

  test('a late or short payment fails the buyer', () => {
    expect(outcome(paid('2026-10-09T00:00:01.000Z'))).toMatchObject({
      state: 'failed', fault: 'buyer', evidence: {reason: 'late_payment', onTime: false},
    });
    expect(outcome(paid('2026-10-07T00:00:00.000Z', '99999'))).toMatchObject({
      state: 'failed', fault: 'buyer', evidence: {reason: 'short_payment', fullAmount: false},
    });
  });

  test('no payment stays pending until the deadline, then fails at the deadline', () => {
    expect(outcome(undefined, '2026-10-09T00:00:00.000Z').state).toBe('pending');
    expect(outcome(undefined, '2026-10-10T00:00:00.000Z')).toMatchObject({
      state: 'failed', fault: 'buyer', decidedAt: '2026-10-09T00:00:00.000Z',
      evidence: {reason: 'unpaid_after_deadline'},
    });
  });

  test('keeps an unverified live payment pending and refuses another currency', () => {
    expect(outcome(paid('2026-10-07T00:00:00.000Z', '100000', {mode: 'live'})).state).toBe('pending');
    expect(outcome(paid('2026-10-07T00:00:00.000Z', '100000', {mode: 'live', verified: true})))
      .toMatchObject({state: 'successful', verificationConfidence: 0.95});
    expect(() => outcome(paid('2026-10-07T00:00:00.000Z', '100000', {currency: 'USDM'})))
      .toThrow('the payment is in USDM');
  });
});
