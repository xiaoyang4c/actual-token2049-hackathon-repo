/**
 * @fileoverview Pins the payment evidence seam shape for lane 4.
 */

import {describe, expect, test} from 'bun:test';
import {
  hashInvoiceTerms,
  StubPaymentEvidenceProducer,
} from '../src/evidence-payment';

const NOW = '2026-10-06T00:00:00.000Z';
const TERMS = {invoiceId: 'INV-1', dueDate: '2026-10-03T00:00:00.000Z'};

describe('StubPaymentEvidenceProducer', () => {
  test('hashes the invoice terms including the due date', () => {
    const hash = hashInvoiceTerms(TERMS);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashInvoiceTerms({...TERMS, dueDate: '2026-10-04T00:00:00.000Z'}))
      .not.toBe(hash);
  });

  test('marks on-time settlement successful and late settlement failed', () => {
    const producer = new StubPaymentEvidenceProducer();
    const onTime = producer.verifyPayment({
      transactionId: 'tx-1', invoiceTerms: TERMS,
      dueDate: '2026-10-03T00:00:00.000Z',
      settlementTimestamp: '2026-10-02T00:00:00.000Z', now: NOW,
    });
    const late = producer.verifyPayment({
      transactionId: 'tx-2', invoiceTerms: TERMS,
      dueDate: '2026-10-03T00:00:00.000Z',
      settlementTimestamp: '2026-10-05T00:00:00.000Z', now: NOW,
    });
    expect(onTime.state).toBe('successful');
    expect(onTime.fault).toBeUndefined();
    expect(late.state).toBe('failed');
    expect(late.fault).toBe('buyer');
    expect(onTime.verificationMethod).toBe('payment-settlement');
    expect(onTime.evidence['termsHash'])
      .toBe(hashInvoiceTerms(TERMS));
  });
});
