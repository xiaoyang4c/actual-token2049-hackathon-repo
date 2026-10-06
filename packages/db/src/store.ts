/**
 * @fileoverview SQLite connection lifecycle and facade for agent record queries.
 */

import {Database} from 'bun:sqlite';
import type {Portfolio, Venue} from '../../core/src/types';
import type {MarketQuote} from '../../core/src/portfolio';
import type {
  AgentStateRecord, AuditEventRecord, DailySummaryRecord, MarketResolutionRecord,
  NewAuditEvent, NewPolicyRecord, OrderRecord, PaymentReceiptRecord, PolicyRecord,
  PositionEventRecord, RunRecord,
} from './records';
import * as agentBook from './agent-book';
import * as cycleRecords from './cycle-records';
import * as paymentReceipts from './payment-receipts';
import * as paymentSettlements from './payment-settlements';
import * as lifecycleRecords from './lifecycle-records';
import * as reliabilityRecords from './reliability';
import type {
  Entity, EntityRole, JsonValue, MarketplaceTransaction, Outcome,
  ReliabilityCategory, ReliabilityEvent, ReliabilityState, TermsDecision,
  TermsVersion,
} from '../../reliability/src/types';
import type {
  PaymentSettlementRecord, SettlementObservationInput, SettlementObservationRecord,
  SettlementStatus,
} from './payment-settlements';
import {applyMigrations} from './migrate';

export type {
  AgentStateRecord, AuditEventRecord, DailySummaryRecord, MarketResolutionRecord,
  NewAuditEvent, NewPolicyRecord, OrderMode, OrderRecord, OrderStatus,
  PaymentReceiptRecord, PolicyRecord, PositionEventRecord, ReceiptStatus, RunRecord,
  RunStatus,
} from './records';

export type {
  PaymentSettlementRecord, SettlementObservationInput, SettlementObservationRecord,
  SettlementStatus,
} from './payment-settlements';

/**
 * Stores agent policy, cycle runs, orders, audit events, and payment
 * receipts. Opening the store applies migrations. It does not contact
 * the network.
 */
export class AgentStore {
  private constructor(private readonly db: Database) {}

  /**
   * Opens a SQLite database and applies migrations.
   * @param filename Path to the database file. Omit for a private
   *     in-memory database.
   */
  static open(filename = ':memory:'): AgentStore {
    const db = new Database(filename);
    try {
      db.run('PRAGMA busy_timeout = 5000');
      applyMigrations(db);
      return new AgentStore(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** Closes the database connection. */
  close(): void {
    this.db.close();
  }

  /** Runs synchronous work atomically, taking the write lock before reads. */
  transaction<T>(work: () => T): T {
    return this.db.transaction(work).immediate();
  }

  /** Reads the current book. Historical runs do not replace this snapshot. */
  getAgentState(): AgentStateRecord|undefined {
    return agentBook.getAgentState(this.db);
  }

  /** Saves the complete book. Use a transaction when also storing a fill. */
  saveAgentState(record: AgentStateRecord): AgentStateRecord {
    return agentBook.saveAgentState(this.db, record);
  }

  getMarketQuote(venue: Venue, marketId: string): MarketQuote|undefined {
    return agentBook.getMarketQuote(this.db, venue, marketId);
  }

  listMarketQuotes(): MarketQuote[] {
    return agentBook.listMarketQuotes(this.db);
  }

  saveMarketQuote(quote: MarketQuote): void {
    agentBook.saveMarketQuote(this.db, quote);
  }

  getPositionEvent(key: string): PositionEventRecord|undefined {
    return agentBook.getPositionEvent(this.db, key);
  }

  listPositionEvents(): PositionEventRecord[] {
    return agentBook.listPositionEvents(this.db);
  }

  insertPositionEvent(record: PositionEventRecord): void {
    agentBook.insertPositionEvent(this.db, record);
  }

  getMarketResolution(venue: Venue, marketId: string): MarketResolutionRecord|undefined {
    return agentBook.getMarketResolution(this.db, venue, marketId);
  }

  insertMarketResolution(record: MarketResolutionRecord): void {
    agentBook.insertMarketResolution(this.db, record);
  }

  insertDailySummary(record: DailySummaryRecord): void {
    agentBook.insertDailySummary(this.db, record);
  }

  listDailySummaries(): DailySummaryRecord[] {
    return agentBook.listDailySummaries(this.db);
  }

  /** Inserts a policy snapshot and returns the stored row. */
  insertPolicy(record: NewPolicyRecord): PolicyRecord {
    return cycleRecords.insertPolicy(this.db, record);
  }

  /** Returns the policy row, or undefined when `id` is absent. */
  getPolicy(id: number): PolicyRecord|undefined {
    return cycleRecords.getPolicy(this.db, id);
  }

  /** Inserts a cycle run and returns the stored row. */
  insertRun(record: RunRecord): RunRecord {
    return cycleRecords.insertRun(this.db, record);
  }

  /** Returns the run, or undefined when `id` is absent. */
  getRun(id: string): RunRecord|undefined {
    return cycleRecords.getRun(this.db, id);
  }

  /** Commits the portfolio after a paper order batch completes. */
  finishPaperRun(id: string, portfolio: Portfolio, finishedAt: string): void {
    cycleRecords.finishPaperRun(this.db, id, portfolio, finishedAt);
  }

  /**
   * Inserts an order fill and returns the stored row. A repeated idempotency
   * key writes nothing and returns the row stored first, the same way the
   * control API answers a repeated order.
   */
  insertOrder(record: OrderRecord): OrderRecord {
    return cycleRecords.insertOrder(this.db, record);
  }

  /** Returns the order, or undefined when the key is absent. */
  getOrder(idempotencyKey: string): OrderRecord|undefined {
    return cycleRecords.getOrder(this.db, idempotencyKey);
  }

  /** Inserts one audit event and returns the stored row. */
  insertAuditEvent(record: NewAuditEvent): AuditEventRecord {
    return cycleRecords.insertAuditEvent(this.db, record);
  }

  /** Returns the audit event, or undefined when `id` is absent. */
  getAuditEvent(id: number): AuditEventRecord|undefined {
    return cycleRecords.getAuditEvent(this.db, id);
  }

  /**
   * Inserts an x402 or Masumi receipt. Payer, amount, transaction hash,
   * receipt id, and status are stored as given. The optional cycle and
   * order links are foreign keys, not network calls.
   */
  insertPaymentReceipt(record: PaymentReceiptRecord): PaymentReceiptRecord {
    return paymentReceipts.insertPaymentReceipt(this.db, record);
  }

  /** Returns the receipt, or undefined when `receiptId` is absent. */
  getPaymentReceipt(receiptId: string): PaymentReceiptRecord|undefined {
    return paymentReceipts.getPaymentReceipt(this.db, receiptId);
  }

  /** Finds a payment across service restarts. */
  getPaymentReceiptByKey(key: string): PaymentReceiptRecord|undefined {
    return paymentReceipts.getPaymentReceiptByKey(this.db, key);
  }

  /** Lists receipts in creation order. */
  listPaymentReceipts(): PaymentReceiptRecord[] {
    return paymentReceipts.listPaymentReceipts(this.db);
  }

  /** Updates lifecycle fields in one durable write. Payment terms stay fixed. */
  updatePaymentReceipt(record: PaymentReceiptRecord): PaymentReceiptRecord {
    return paymentReceipts.updatePaymentReceipt(this.db, record);
  }

  /** Creates a settlement schedule without replacing existing evidence. */
  ensurePaymentSettlement(receiptId: string, at: string): PaymentSettlementRecord {
    return paymentSettlements.ensurePaymentSettlement(this.db, receiptId, at);
  }

  /** Wakes reconciliation at an earlier time, keeping the financial history. */
  schedulePaymentSettlement(receiptId: string, at: string): PaymentSettlementRecord {
    return paymentSettlements.schedulePaymentSettlement(this.db, receiptId, at);
  }

  getPaymentSettlement(receiptId: string): PaymentSettlementRecord|undefined {
    return paymentSettlements.getPaymentSettlement(this.db, receiptId);
  }

  listDuePaymentSettlements(at: string, limit = 25): PaymentSettlementRecord[] {
    return paymentSettlements.listDuePaymentSettlements(this.db, at, limit);
  }

  /** Commits the observation, summary, and next check in one transaction. */
  recordPaymentSettlementObservation(
    input: SettlementObservationInput,
  ): PaymentSettlementRecord {
    return paymentSettlements.recordPaymentSettlementObservation(this.db, input);
  }

  /** Lists the most recent observations in commit order, oldest to newest. */
  listPaymentSettlementObservations(
    receiptId: string,
    limit = 100,
  ): SettlementObservationRecord[] {
    return paymentSettlements.listPaymentSettlementObservations(this.db, receiptId, limit);
  }

  /** Reads verified proof without a limit on failed observations after it. */
  getLastVerifiedPaymentSettlementObservation(
    receiptId: string,
    status?: SettlementStatus,
  ): SettlementObservationRecord|undefined {
    return paymentSettlements.getLastVerifiedPaymentSettlementObservation(
      this.db, receiptId, status,
    );
  }

  /**
   * Reliability marketplace tables. Listings stay fixtures only; the
   * store keeps entities, transactions, outcomes, events, states, and
   * terms decisions. Lane D owns the fixtures.
   */

  /** Inserts an entity and its wallets. Wallets must be new. */
  insertEntity(record: Entity): Entity {
    return reliabilityRecords.insertEntity(this.db, record);
  }

  /** Returns the entity, or undefined when `id` is absent. */
  getEntity(id: string): Entity|undefined {
    return reliabilityRecords.getEntity(this.db, id);
  }

  /** Lists entities in id order. */
  listEntities(): Entity[] {
    return reliabilityRecords.listEntities(this.db);
  }

  /** Links one wallet to an entity. */
  addWallet(entityId: string, wallet: string, addedAt: string): void {
    reliabilityRecords.addWallet(this.db, entityId, wallet, addedAt);
  }

  /** Inserts a transaction with its first terms version. */
  insertTransaction(record: MarketplaceTransaction): MarketplaceTransaction {
    return reliabilityRecords.insertTransaction(this.db, record);
  }

  /** Returns the transaction with versions, or undefined when absent. */
  getTransaction(id: string): MarketplaceTransaction|undefined {
    return reliabilityRecords.getTransaction(this.db, id);
  }

  /** Lists transactions with versions in id order. */
  listTransactions(): MarketplaceTransaction[] {
    return reliabilityRecords.listTransactions(this.db);
  }

  /** Appends one terms version. Terms never change without a version. */
  insertTermsVersion(transactionId: string, version: TermsVersion): void {
    reliabilityRecords.insertTermsVersion(this.db, transactionId, version);
  }

  /** Stores the outcome of a transaction. One outcome per transaction. */
  saveOutcome(record: Outcome): Outcome {
    return reliabilityRecords.saveOutcome(this.db, record);
  }

  /** Returns the outcome, or undefined when the transaction has none. */
  getOutcome(transactionId: string): Outcome|undefined {
    return reliabilityRecords.getOutcome(this.db, transactionId);
  }

  /** Inserts one reliability event. Event ids are unique. */
  insertReliabilityEvent(record: ReliabilityEvent): void {
    reliabilityRecords.insertReliabilityEvent(this.db, record);
  }

  /** Lists events of one transaction in id order. */
  listReliabilityEventsForTransaction(transactionId: string): ReliabilityEvent[] {
    return reliabilityRecords.listReliabilityEventsForTransaction(
      this.db, transactionId,
    );
  }

  /** Lists events of one entity, category, and role in id order. */
  listReliabilityEventsForState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
  ): ReliabilityEvent[] {
    return reliabilityRecords.listReliabilityEventsForState(
      this.db, entityId, category, role,
    );
  }

  /** Stores one per-role posterior. Replaces the previous triple. */
  saveReliabilityState(record: ReliabilityState): ReliabilityState {
    return reliabilityRecords.saveReliabilityState(this.db, record);
  }

  /** Returns one posterior, or undefined when the triple is absent. */
  getReliabilityState(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
  ): ReliabilityState|undefined {
    return reliabilityRecords.getReliabilityState(
      this.db, entityId, category, role,
    );
  }

  /** Lists posteriors in entity, category, and role order. */
  listReliabilityStates(): ReliabilityState[] {
    return reliabilityRecords.listReliabilityStates(this.db);
  }

  /** Inserts one terms and fee decision and returns its row id. */
  insertTermsDecision(record: TermsDecision): number {
    return reliabilityRecords.insertTermsDecision(this.db, record);
  }

  /** Lists decisions for one entity and category, oldest first. */
  listTermsDecisions(
    entityId: string, category: ReliabilityCategory,
  ): TermsDecision[] {
    return reliabilityRecords.listTermsDecisions(this.db, entityId, category);
  }

  /**
   * Appends one lifecycle stage change.
   * Lane A owns this history. KYC does not write these rows.
   */
  insertLifecycleTransition(
    record: lifecycleRecords.LifecycleTransitionRecord,
  ): void {
    lifecycleRecords.insertLifecycleTransition(this.db, record);
  }

  /** Lists lifecycle stage changes for one transaction, oldest first. */
  listLifecycleTransitions(
    transactionId: string,
  ): lifecycleRecords.LifecycleTransitionRecord[] {
    return lifecycleRecords.listLifecycleTransitions(this.db, transactionId);
  }

  /**
   * Points a transaction at new terms.
   * Pass `undefined` for `termsHash` to clear a stale hash.
   * Append a terms version first. This write does not edit older versions.
   */
  updateTransactionTerms(
    transactionId: string,
    terms: {[key: string]: JsonValue},
    termsHash: string|undefined,
  ): void {
    lifecycleRecords.updateTransactionTerms(
      this.db, transactionId, terms, termsHash,
    );
  }

  /** Records the time a transaction reached a terminal outcome. */
  setTransactionCompletedAt(transactionId: string, completedAt: string): void {
    lifecycleRecords.setTransactionCompletedAt(
      this.db, transactionId, completedAt,
    );
  }
}
