/**
 * @fileoverview Payment behavior evidence seam for lane D (B2B).
 * TODO(lane-D): replace StubPaymentEvidenceProducer with the real check
 * that hashes the invoice terms including the due date at creation and
 * compares that hash with the settlement timestamp. This stub only pins
 * the interface shape with a deterministic comparison.
 */

import {createHash} from 'node:crypto';
import type {JsonValue, Outcome} from './types';

export const STUB_PAYMENT_EVIDENCE_VERSION = 'payment-evidence-stub-v0';

/** Input to one payment behavior check. */
export interface PaymentVerificationInput {
  transactionId: string;
  invoiceTerms: {[key: string]: unknown};
  dueDate: string;
  settlementTimestamp: string;
  settlementTxHash?: string;
  now: string;
}

/** Hashes invoice terms including the due date. Lane 4 owns the format. */
export function hashInvoiceTerms(terms: {[key: string]: unknown}): string {
  return createHash('sha256')
    .update(JSON.stringify(terms))
    .digest('hex');
}

/**
 * Payment outcome evidence seam. Lane 4 owns the real hash and
 * settlement comparison. The stub marks on-time payment successful
 * and leaves fault empty. A late payment is a buyer fault.
 */
export interface PaymentEvidenceProducer {
  readonly version: string;
  verifyPayment(input: PaymentVerificationInput): Outcome;
}

/** Deterministic placeholder. Reads no chain timestamp itself. */
export class StubPaymentEvidenceProducer implements PaymentEvidenceProducer {
  readonly version = STUB_PAYMENT_EVIDENCE_VERSION;

  verifyPayment(input: PaymentVerificationInput): Outcome {
    if (input.dueDate === '' || input.settlementTimestamp === '') {
      throw new Error('dueDate and settlementTimestamp must be non-empty');
    }
    const termsHash = hashInvoiceTerms(input.invoiceTerms);
    const onTime =
      Date.parse(input.settlementTimestamp) <= Date.parse(input.dueDate);
    const evidence: {[key: string]: JsonValue} = {
      termsHash,
      dueDate: input.dueDate,
      settlementTimestamp: input.settlementTimestamp,
      settlementTxHash: input.settlementTxHash ?? null,
      producer: this.version,
    };
    if (onTime) {
      return {
        transactionId: input.transactionId,
        state: 'successful',
        evidence,
        verificationMethod: 'payment-settlement',
        verificationConfidence: 0.5,
        decidedAt: input.now,
      };
    }
    return {
      transactionId: input.transactionId,
      state: 'failed',
      fault: 'buyer',
      evidence,
      verificationMethod: 'payment-settlement',
      verificationConfidence: 0.5,
      decidedAt: input.now,
    };
  }
}
