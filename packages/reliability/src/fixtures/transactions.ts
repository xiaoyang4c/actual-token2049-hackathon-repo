/**
 * @fileoverview Seed transactions and outcomes for the read endpoints.
 * Lane D owns this file. It covers a service sale (B2C), an
 * invoice/payables transaction (B2B), and the repeat goods sales of the
 * farming pair. Service and goods outcomes come from the generic
 * transaction lifecycle. The invoice outcome comes from payment
 * evidence: the hashed due date against the settlement timestamp.
 */

import {hashInvoiceTerms} from '../evidence-payment';
import type {MarketplaceTransaction, Outcome} from '../types';

const SERVICE_TERMS = {
  service: 'Monthly bookkeeping (up to 200 transactions)',
  deliveryDeadline: '2026-10-07T00:00:00.000Z',
};

/** Verified service sale between the new and established entities. */
export const TX_SERVICE: MarketplaceTransaction = {
  id: 'tx-service-1',
  type: 'service',
  participants: [
    {entityId: 'entity-new', role: 'buyer'},
    {entityId: 'entity-established', role: 'seller'},
  ],
  terms: SERVICE_TERMS,
  versions: [
    {
      version: 1, terms: SERVICE_TERMS, reason: 'initial terms',
      createdAt: '2026-10-04T10:00:00.000Z',
    },
  ],
  value: 250,
  createdAt: '2026-10-04T10:00:00.000Z',
  completedAt: '2026-10-04T12:00:00.000Z',
};

export const OUTCOME_SERVICE: Outcome = {
  transactionId: 'tx-service-1',
  state: 'successful',
  evidence: {
    stage: 'payment_settled',
    escrowTx: 'simulated-escrow-tx-service-1',
    deliveryConfirmedAt: '2026-10-04T11:30:00.000Z',
    producer: 'lifecycle-v1',
    mode: 'paper',
  },
  verificationMethod: 'lifecycle',
  verificationConfidence: 0.5,
  decidedAt: '2026-10-04T12:00:00.000Z',
};

const INVOICE_TERMS = {
  invoiceId: 'INV-2026-1042',
  amount: 1200,
  currency: 'USD',
  dueDate: '2026-10-03T00:00:00.000Z',
};

/** Verified on-time B2B invoice payment. The hash covers the due date. */
export const TX_INVOICE: MarketplaceTransaction = {
  id: 'tx-invoice-1',
  type: 'invoice',
  participants: [
    {entityId: 'entity-established', role: 'buyer'},
    {entityId: 'entity-new', role: 'seller'},
  ],
  terms: INVOICE_TERMS,
  termsHash: hashInvoiceTerms(INVOICE_TERMS),
  versions: [
    {
      version: 1, terms: INVOICE_TERMS, reason: 'initial terms',
      createdAt: '2026-09-03T00:00:00.000Z',
    },
    {
      version: 2,
      terms: {...INVOICE_TERMS, paymentDays: 30},
      reason: 'buyer requested net-30 amendment',
      createdAt: '2026-09-04T00:00:00.000Z',
    },
  ],
  value: 1200,
  createdAt: '2026-09-03T00:00:00.000Z',
  completedAt: '2026-10-02T00:00:00.000Z',
};

export const OUTCOME_INVOICE: Outcome = {
  transactionId: 'tx-invoice-1',
  state: 'successful',
  evidence: {
    termsHash: hashInvoiceTerms(INVOICE_TERMS),
    dueDate: '2026-10-03T00:00:00.000Z',
    settlementTimestamp: '2026-10-02T00:00:00.000Z',
    settlementTxHash: null,
    producer: 'payment-evidence-stub-v0',
  },
  verificationMethod: 'payment-settlement',
  verificationConfidence: 0.5,
  decidedAt: '2026-10-02T00:00:00.000Z',
};

/** Twelve small repeat goods sales between the farming pair. */
export const FARM_TRANSACTIONS: MarketplaceTransaction[] =
  buildFarmTransactions();

function buildFarmTransactions(): MarketplaceTransaction[] {
  const list: MarketplaceTransaction[] = [];
  for (let batch = 1; batch <= 12; batch++) {
    const day = String(batch).padStart(2, '0');
    const terms = {goods: 'USB-C cable 2m braided', quantity: 10};
    list.push({
      id: `tx-farm-${day}`,
      type: 'goods',
      participants: [
        {entityId: 'entity-farm-b', role: 'buyer'},
        {entityId: 'entity-farm-a', role: 'seller'},
      ],
      terms,
      versions: [
        {
          version: 1,
          terms,
          reason: 'initial terms',
          createdAt: `2026-09-${day}T10:00:00.000Z`,
        },
      ],
      value: 50,
      createdAt: `2026-09-${day}T10:00:00.000Z`,
      completedAt: `2026-09-${day}T11:00:00.000Z`,
    });
  }
  return list;
}

/** All farm outcomes verify through the generic lifecycle. */
export const FARM_OUTCOMES: Outcome[] = FARM_TRANSACTIONS.map(
  (transaction) => ({
    transactionId: transaction.id,
    state: 'successful' as const,
    evidence: {
      stage: 'payment_settled',
      escrowTx: `simulated-escrow-${transaction.id}`,
      deliveryConfirmedAt: transaction.completedAt ?? transaction.createdAt,
      producer: 'lifecycle-v1',
      mode: 'paper',
    },
    verificationMethod: 'lifecycle' as const,
    verificationConfidence: 0.5,
    decidedAt: transaction.completedAt ?? transaction.createdAt,
  }),
);

/** Seed transactions in a stable order for the read endpoints. */
export const FIXTURE_TRANSACTIONS: MarketplaceTransaction[] = [
  TX_SERVICE,
  TX_INVOICE,
  ...FARM_TRANSACTIONS,
];

/** Seed outcomes in a stable order for the read endpoints. */
export const FIXTURE_OUTCOMES: Outcome[] = [
  OUTCOME_SERVICE,
  OUTCOME_INVOICE,
  ...FARM_OUTCOMES,
];

/**
 * Failed service. Only the seller role is at fault.
 * This row is paper. It is not in the seed list. It shares an id with
 * the successful service outcome.
 */
export const OUTCOME_SELLER_FAULT: Outcome = {
  transactionId: 'tx-service-1',
  state: 'failed',
  fault: 'seller',
  evidence: {
    stage: 'refunded',
    producer: 'lifecycle-v1',
  },
  verificationMethod: 'manual-review',
  verificationConfidence: 0.85,
  decidedAt: '2026-10-06T00:00:00.000Z',
};

/**
 * Late invoice payment. Only the buyer role is at fault.
 * This row is paper. It is not in the seed list. It shares an id with
 * the successful invoice outcome.
 */
export const OUTCOME_BUYER_FAULT: Outcome = {
  transactionId: 'tx-invoice-1',
  state: 'failed',
  fault: 'buyer',
  evidence: {
    termsHash: hashInvoiceTerms(INVOICE_TERMS),
    dueDate: '2026-10-03T00:00:00.000Z',
    settlementTimestamp: '2026-10-05T00:00:00.000Z',
    settlementTxHash: null,
    producer: 'payment-evidence-stub-v0',
  },
  verificationMethod: 'payment-settlement',
  verificationConfidence: 0.5,
  decidedAt: '2026-10-05T00:00:00.000Z',
};

/**
 * Failed outcome with no at-fault party. Neither score changes.
 * This row is paper. It is not in the seed list.
 */
export const OUTCOME_NO_FAULT: Outcome = {
  transactionId: 'tx-service-1',
  state: 'failed',
  fault: 'none',
  evidence: {
    stage: 'refunded',
    producer: 'lifecycle-v1',
  },
  verificationMethod: 'lifecycle',
  verificationConfidence: 0.9,
  decidedAt: '2026-10-06T00:00:00.000Z',
};
