/**
 * @fileoverview B2B invoices with payment evidence (lane D).
 *
 * issue checks both parties, hashes the canonical invoice terms, stores the
 * hash on the transaction, and records the accepted fees. settle checks a
 * payment observation against the agreed terms and scores the result.
 * review fails an unpaid invoice once its deadline passes.
 *
 * Invoices are paper. The paper source labels each payment unverified.
 * Live settlement needs a source that confirms the token receipt on chain.
 * That USDM receipt check does not exist yet, so no live source ships.
 */

import type {AgentStore} from '../../packages/db/src/index';
import {
  INVOICE_TERMS_SCHEMA, InvoiceEvidenceError, invoiceOutcome, invoiceTermsHash,
  validateInvoiceTerms, type InvoiceSettlement, type InvoiceTerms,
} from '../../packages/reliability/src/evidence-payment';
import {toMinorUnits, type FeeCharge} from '../../packages/reliability/src/fee-charges';
import type {
  JsonValue, Listing, MarketplaceTransaction, Outcome, ReliabilityEvent,
} from '../../packages/reliability/src/types';
import {
  FeeBook, MARKETPLACE_CURRENCIES, MarketplaceGate, platformFeeTerms, reliabilityTerms,
} from './marketplace-gate';
import {DEFAULT_RELIABILITY_POLICIES, type ReliabilityPolicies} from './policies';
import {projectOutcome} from './reliability-projection';
import {withRecordedWeights} from './score-ledger';

/** A rejected invoice request. */
export class InvoiceError extends Error {
  constructor(
    readonly code: 'not_found'|'invalid_input'|'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'InvoiceError';
  }
}

/** Where payment observations come from. */
export interface InvoiceSettlementSource {
  readonly mode: 'paper'|'live';
  observe(input: {
    transactionId: string;
    reference: string;
    currency: string;
    expectedAmountMinor: string;
    paper?: {settledAt?: string; amountMinor?: string};
  }): Promise<InvoiceSettlement>;
}

/** Paper source: trusts the supplied time and amount, and marks them unverified. */
export class PaperInvoiceSettlementSource implements InvoiceSettlementSource {
  readonly mode = 'paper';

  observe(input: Parameters<InvoiceSettlementSource['observe']>[0]): Promise<InvoiceSettlement> {
    const settledAt = input.paper?.settledAt;
    if (!settledAt || Number.isNaN(Date.parse(settledAt))) {
      return Promise.reject(new InvoiceError('invalid_input', 'a paper settlement needs settledAt as an ISO time'));
    }
    return Promise.resolve({
      reference: input.reference, settledAt,
      amountMinor: input.paper?.amountMinor ?? input.expectedAmountMinor,
      currency: input.currency, verified: false, mode: 'paper',
    });
  }
}

export interface IssueInvoiceInput {
  id: string;
  buyerId: string;
  sellerId: string;
  invoiceNumber: string;
  /** Amount in major units of `currency`. */
  amount: number;
  currency?: string;
  dueDate: string;
  graceHours?: number;
  description?: string;
  listing?: Listing;
  at: string;
}

export interface InvoiceView {
  mode: 'paper'|'live';
  transaction: MarketplaceTransaction;
  invoice: InvoiceTerms;
  termsHash: string;
  outcome: Outcome|undefined;
  events: ReliabilityEvent[];
  feeCharge: FeeCharge|null;
  settlement: ReturnType<AgentStore['getInvoiceSettlement']>|null;
}

export interface InvoiceServiceOptions {
  policies?: ReliabilityPolicies;
  /** KYC, limits, payment days, and fee charges at issue. Defaults to true. */
  enforceMarketplaceRules?: boolean;
  settlements?: InvoiceSettlementSource;
}

function invoiceJson(terms: InvoiceTerms): {[key: string]: JsonValue} {
  return {
    schema: terms.schema, invoiceNumber: terms.invoiceNumber, buyerId: terms.buyerId,
    sellerId: terms.sellerId, amountMinor: terms.amountMinor, currency: terms.currency,
    decimals: terms.decimals, issuedAt: terms.issuedAt, dueDate: terms.dueDate,
    graceHours: terms.graceHours,
    ...(terms.description === undefined ? {} : {description: terms.description}),
  };
}

const FINAL_STATES = new Set(['successful', 'failed', 'cancelled']);

/** One invoice service per store. */
export class InvoiceService {
  readonly gate: MarketplaceGate;
  readonly fees: FeeBook;
  private readonly policies: ReliabilityPolicies;
  private readonly enforce: boolean;
  private readonly settlements: InvoiceSettlementSource;

  constructor(private readonly store: AgentStore, options: InvoiceServiceOptions = {}) {
    this.policies = withRecordedWeights(store, options.policies ?? DEFAULT_RELIABILITY_POLICIES);
    this.gate = new MarketplaceGate(store, this.policies);
    this.fees = new FeeBook(store);
    this.enforce = options.enforceMarketplaceRules ?? true;
    this.settlements = options.settlements ?? new PaperInvoiceSettlementSource();
  }

  /** Issues an invoice after the marketplace checks. */
  issue(input: IssueInvoiceInput): InvoiceView {
    const currency = input.currency ?? 'USD';
    this.store.transaction(() => {
      if (this.store.getTransaction(input.id)) throw new InvoiceError('conflict', `transaction ${input.id} already exists`);
      if (!Number.isFinite(input.amount) || input.amount <= 0) {
        throw new InvoiceError('invalid_input', 'amount must be a positive number');
      }
      const check = this.enforce ? this.gate.assertDeal({
        type: 'invoice', buyerId: input.buyerId, sellerId: input.sellerId, value: input.amount,
        currency, terms: {dueDate: input.dueDate}, listing: input.listing, now: input.at,
      }) : undefined;
      if (!this.enforce) {
        for (const id of [input.buyerId, input.sellerId]) {
          if (this.store.getEntity(id)) continue;
          this.store.insertEntity({
            id, displayName: id, wallets: [], kycStatus: 'unverified', kycTier: 'none',
            roles: ['buyer', 'seller'], createdAt: input.at,
          });
        }
      }
      const decimals = MARKETPLACE_CURRENCIES.get(currency);
      if (decimals === undefined) throw new InvoiceError('invalid_input', `currency ${currency} is not supported`);
      const invoice: InvoiceTerms = {
        schema: INVOICE_TERMS_SCHEMA, invoiceNumber: input.invoiceNumber,
        buyerId: input.buyerId, sellerId: input.sellerId,
        amountMinor: toMinorUnits(input.amount, decimals).toString(), currency, decimals,
        issuedAt: input.at, dueDate: input.dueDate, graceHours: input.graceHours ?? 0,
        ...(input.description === undefined ? {} : {description: input.description}),
      };
      try {
        validateInvoiceTerms(invoice);
      } catch (error) {
        if (error instanceof InvoiceEvidenceError) throw new InvoiceError('invalid_input', error.message);
        throw error;
      }
      const feeCharge = check ? this.fees.quote(check, input.id, input.at) : undefined;
      const terms: {[key: string]: JsonValue} = {
        invoice: invoiceJson(invoice), dueDate: invoice.dueDate, currency,
        ...(feeCharge && check ? {platformFees: platformFeeTerms(feeCharge), reliabilityTerms: reliabilityTerms(check)} : {}),
      };
      this.store.insertTransaction({
        id: input.id, type: 'invoice',
        participants: [{entityId: input.buyerId, role: 'buyer'}, {entityId: input.sellerId, role: 'seller'}],
        terms, termsHash: invoiceTermsHash(invoice),
        versions: [{version: 1, terms, reason: 'invoice issued', createdAt: input.at}],
        value: input.amount, createdAt: input.at,
      });
      if (feeCharge) this.fees.accept(feeCharge);
      this.store.saveOutcome(invoiceOutcome({
        transactionId: input.id, terms: invoice, termsHash: invoiceTermsHash(invoice), now: input.at,
      }));
    });
    return this.view(input.id);
  }

  /** Records a payment and scores the result against the agreed terms. */
  async settle(input: {
    transactionId: string; reference: string; settledAt?: string; amountPaid?: number; at: string;
  }): Promise<InvoiceView> {
    const {transaction, invoice} = this.invoice(input.transactionId);
    const recorded = this.store.getInvoiceSettlement(input.transactionId);
    if (recorded) {
      // A repeated paper payment, or an already verified one, changes nothing.
      // An unverified live payment is observed again until it confirms.
      if (recorded.reference === input.reference && (recorded.verified || recorded.mode === 'paper')) {
        return this.view(input.transactionId);
      }
      if (recorded.reference !== input.reference) {
        throw new InvoiceError('conflict', `invoice ${input.transactionId} already has payment ${recorded.reference}`);
      }
    }
    const owner = this.store.invoiceForSettlementReference(input.reference);
    if (owner && owner !== input.transactionId) {
      throw new InvoiceError('conflict', `payment ${input.reference} already settled invoice ${owner}`);
    }
    if (input.amountPaid !== undefined && (!Number.isFinite(input.amountPaid) || input.amountPaid < 0)) {
      throw new InvoiceError('invalid_input', 'amountPaid must be a non-negative number');
    }
    const observed = await this.settlements.observe({
      transactionId: input.transactionId, reference: input.reference, currency: invoice.currency,
      expectedAmountMinor: invoice.amountMinor,
      paper: {
        ...(input.settledAt ? {settledAt: input.settledAt} : {}),
        ...(input.amountPaid === undefined ? {} : {amountMinor: toMinorUnits(input.amountPaid, invoice.decimals).toString()}),
      },
    });
    const outcome = this.outcome(transaction, invoice, observed, input.at);
    this.store.transaction(() => {
      this.store.saveInvoiceSettlement({
        transactionId: input.transactionId, reference: observed.reference, mode: observed.mode,
        verified: observed.verified, settledAt: observed.settledAt, amountMinor: observed.amountMinor,
        currency: observed.currency, recordedAt: input.at,
      });
      this.record(transaction, outcome);
    });
    return this.view(input.transactionId);
  }

  /** Fails an unpaid invoice after its deadline. Returns the current view. */
  review(transactionId: string, now: string): InvoiceView {
    const {transaction, invoice} = this.invoice(transactionId);
    if (!this.store.getInvoiceSettlement(transactionId)) {
      const outcome = this.outcome(transaction, invoice, undefined, now);
      if (outcome.state !== 'pending') this.store.transaction(() => this.record(transaction, outcome));
    }
    return this.view(transactionId);
  }

  view(transactionId: string): InvoiceView {
    const {transaction, invoice} = this.invoice(transactionId);
    return {
      mode: this.settlements.mode,
      transaction,
      invoice,
      termsHash: transaction.termsHash ?? '',
      outcome: this.store.getOutcome(transactionId),
      events: this.store.listReliabilityEventsForTransaction(transactionId),
      feeCharge: this.fees.get(transactionId) ?? null,
      settlement: this.store.getInvoiceSettlement(transactionId) ?? null,
    };
  }

  private outcome(
    transaction: MarketplaceTransaction, invoice: InvoiceTerms, settlement: InvoiceSettlement|undefined, now: string,
  ): Outcome {
    try {
      return invoiceOutcome({
        transactionId: transaction.id, terms: invoice, termsHash: transaction.termsHash ?? '', settlement, now,
      });
    } catch (error) {
      if (error instanceof InvoiceEvidenceError) throw new InvoiceError('invalid_input', error.message);
      throw error;
    }
  }

  private record(transaction: MarketplaceTransaction, outcome: Outcome): void {
    this.store.saveOutcome(outcome);
    if (!FINAL_STATES.has(outcome.state)) return;
    if (!this.store.getTransaction(transaction.id)?.completedAt) {
      this.store.setTransactionCompletedAt(transaction.id, outcome.decidedAt);
    }
    projectOutcome(this.store, this.policies, transaction, outcome, outcome.decidedAt);
    this.fees.settle(transaction.id, outcome, 'invoice');
  }

  private invoice(transactionId: string): {transaction: MarketplaceTransaction; invoice: InvoiceTerms} {
    const transaction = this.store.getTransaction(transactionId);
    if (!transaction) throw new InvoiceError('not_found', `unknown invoice ${transactionId}`);
    const invoice = transaction.terms.invoice;
    if (transaction.type !== 'invoice' || typeof invoice !== 'object' || invoice === null || Array.isArray(invoice)) {
      throw new InvoiceError('not_found', `${transactionId} is not an issued invoice`);
    }
    return {transaction, invoice: invoice as unknown as InvoiceTerms};
  }
}
