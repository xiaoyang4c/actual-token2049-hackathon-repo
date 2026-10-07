/**
 * @fileoverview Payment behavior evidence for lane D (B2B invoices).
 *
 * At issue time the platform hashes the canonical invoice terms, with the
 * due date, and stores the hash on the transaction. At payment time
 * invoiceOutcome checks that the presented terms match that hash, that the
 * settlement currency matches, that the full amount arrived, and that it
 * arrived by the due date plus grace. A late or short payment fails the
 * buyer. No payment after the deadline fails the buyer at the deadline.
 * A live settlement that is not verified yet stays pending.
 *
 * StubPaymentEvidenceProducer stays for the original seam tests.
 */

import {createHash} from 'node:crypto';
import {canonicalize} from './contract-lifecycle/canonical-json';
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

export const INVOICE_TERMS_SCHEMA = 'invoice-terms.v1';
export const INVOICE_EVIDENCE_VERSION = 'invoice-payment-v1';

/** Terms that the invoice hash covers. Amounts are integer minor units. */
export interface InvoiceTerms {
  schema: typeof INVOICE_TERMS_SCHEMA;
  invoiceNumber: string;
  buyerId: string;
  sellerId: string;
  amountMinor: string;
  currency: string;
  decimals: number;
  issuedAt: string;
  dueDate: string;
  /** Hours after the due date that still count as on time. */
  graceHours: number;
  description?: string;
}

/** A payment observation. `verified` is true only for confirmed chain proof. */
export interface InvoiceSettlement {
  reference: string;
  settledAt: string;
  amountMinor: string;
  currency: string;
  verified: boolean;
  mode: 'paper'|'live';
}

/** Evidence that does not bind to the agreed invoice. */
export class InvoiceEvidenceError extends Error {
  constructor(
    readonly code: 'terms_mismatch'|'currency_mismatch'|'invalid_terms',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceEvidenceError';
  }
}

/** SHA-256 of the canonical (JCS) invoice terms. */
export function invoiceTermsHash(terms: InvoiceTerms): string {
  return createHash('sha256').update(canonicalize(terms)).digest('hex');
}

/** Rejects terms that cannot be checked. */
export function validateInvoiceTerms(terms: InvoiceTerms): void {
  const problems: string[] = [];
  if (terms.schema !== INVOICE_TERMS_SCHEMA) problems.push(`schema must be ${INVOICE_TERMS_SCHEMA}`);
  if (!/^[1-9][0-9]*$/.test(terms.amountMinor)) problems.push('amountMinor must be a positive integer string');
  for (const key of ['invoiceNumber', 'buyerId', 'sellerId', 'currency'] as const) {
    if (typeof terms[key] !== 'string' || terms[key].trim() === '') problems.push(`${key} is required`);
  }
  if (Number.isNaN(Date.parse(terms.issuedAt)) || Number.isNaN(Date.parse(terms.dueDate))) {
    problems.push('issuedAt and dueDate must be ISO times');
  } else if (Date.parse(terms.dueDate) <= Date.parse(terms.issuedAt)) {
    problems.push('dueDate must be after issuedAt');
  }
  if (!Number.isFinite(terms.graceHours) || terms.graceHours < 0) problems.push('graceHours must be non-negative');
  if (problems.length > 0) throw new InvoiceEvidenceError('invalid_terms', problems.join('; '));
}

/** Due date plus grace, in milliseconds. */
export function invoiceDeadline(terms: InvoiceTerms): number {
  return Date.parse(terms.dueDate) + terms.graceHours * 60 * 60 * 1000;
}

/**
 * Outcome for one invoice from its terms, the stored hash, and the
 * payment observation, if any.
 */
export function invoiceOutcome(input: {
  transactionId: string;
  terms: InvoiceTerms;
  termsHash: string;
  settlement?: InvoiceSettlement;
  now: string;
}): Outcome {
  const {terms, settlement} = input;
  validateInvoiceTerms(terms);
  const hash = invoiceTermsHash(terms);
  if (hash !== input.termsHash) {
    throw new InvoiceEvidenceError('terms_mismatch', 'the invoice terms do not match the hash agreed at issue');
  }
  const deadline = invoiceDeadline(terms);
  const evidence: {[key: string]: JsonValue} = {
    schema: INVOICE_EVIDENCE_VERSION,
    termsHash: hash,
    invoiceNumber: terms.invoiceNumber,
    dueDate: terms.dueDate,
    graceHours: terms.graceHours,
    deadline: new Date(deadline).toISOString(),
    amountDueMinor: terms.amountMinor,
    currency: terms.currency,
  };
  const base = {transactionId: input.transactionId, verificationMethod: 'payment-settlement' as const};
  if (!settlement) {
    if (Date.parse(input.now) <= deadline) {
      return {...base, state: 'pending', evidence: {...evidence, paid: false}, decidedAt: input.now};
    }
    // No payment by the deadline. The decision time is the deadline.
    return {
      ...base, state: 'failed', fault: 'buyer', verificationConfidence: 0.9,
      evidence: {...evidence, paid: false, reason: 'unpaid_after_deadline'},
      decidedAt: new Date(deadline).toISOString(),
    };
  }
  if (settlement.currency !== terms.currency) {
    throw new InvoiceEvidenceError('currency_mismatch', `the payment is in ${settlement.currency}; the invoice is in ${terms.currency}`);
  }
  const fullAmount = BigInt(settlement.amountMinor) >= BigInt(terms.amountMinor);
  const onTime = Date.parse(settlement.settledAt) <= deadline;
  const paid = {
    ...evidence, paid: true, settlementRef: settlement.reference, settledAt: settlement.settledAt,
    amountPaidMinor: settlement.amountMinor, fullAmount, onTime,
    settlementVerified: settlement.verified, mode: settlement.mode,
  };
  if (settlement.mode === 'live' && !settlement.verified) {
    // A queued or unconfirmed payment is not proof.
    return {...base, state: 'pending', evidence: paid, decidedAt: input.now};
  }
  const confidence = settlement.verified ? 0.95 : 0.5;
  if (fullAmount && onTime) {
    return {...base, state: 'successful', verificationConfidence: confidence, evidence: paid, decidedAt: settlement.settledAt};
  }
  return {
    ...base, state: 'failed', fault: 'buyer', verificationConfidence: confidence,
    evidence: {...paid, reason: fullAmount ? 'late_payment' : 'short_payment'},
    decidedAt: settlement.settledAt,
  };
}
