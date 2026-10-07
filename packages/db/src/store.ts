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
import * as kycRecords from './kyc-records';
import * as lifecycleRecords from './lifecycle-records';
import * as lifecycleCommands from './lifecycle-commands';
import type {LifecycleCommandRecord} from '../../reliability/src/lifecycle/commands';
import * as contractRecords from './contract-records';
import * as anchorRecords from './anchor-records';
import type {AnchorBatchRow, AnchoredEntryView, AnchorEntryRow, FinalPublication} from './anchor-records';
import type {
  ContractAuditRow, ContractCommit, EscrowOperation, ProcessedAction, ReliabilityPublication,
} from '../../reliability/src/contract-lifecycle/ports';
import type {
  Contract, ContractParty, EvidenceRecord,
} from '../../reliability/src/contract-lifecycle/types';
import * as reliabilityRecords from './reliability';
import * as omnibusFunding from './omnibus-funding';
import type {
  DealFundingRequest, OmnibusBalance, PaperDealFundingRecord,
  PaperOmnibusPool, PaperPoolDeposit,
} from '../../reliability/src/omnibus-funding';
import type {
  KycProfile, KycReRegistrationSignal, KycStatusRecord,
} from '../../reliability/src/kyc';
import type {
  Entity, EntityRole, JsonValue, KycStatus, KycTier, MarketplaceTransaction,
  Outcome, Listing,
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

  /** Creates a paper pool. An existing pool keeps its address. */
  ensurePaperOmnibusPool(pool: PaperOmnibusPool): PaperOmnibusPool {
    return omnibusFunding.ensurePaperOmnibusPool(this.db, pool);
  }

  /** Credits one simulated deposit output once. */
  recordPaperPoolDeposit(deposit: PaperPoolDeposit): PaperPoolDeposit {
    return omnibusFunding.recordPaperPoolDeposit(this.db, deposit);
  }

  /** Allocates one business balance to a fresh paper deal address. */
  fundPaperDeal(
    request: DealFundingRequest & {poolId: string},
  ): PaperDealFundingRecord {
    return omnibusFunding.fundPaperDeal(this.db, request);
  }

  getOmnibusBalance(poolId: string, businessId: string): OmnibusBalance {
    return omnibusFunding.getOmnibusBalance(this.db, poolId, businessId);
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

  getLifecycleCommand(id: string): LifecycleCommandRecord|undefined {
    return lifecycleCommands.getLifecycleCommand(this.db, id);
  }

  getPendingLifecycleCommand(transactionId: string): LifecycleCommandRecord|undefined {
    return lifecycleCommands.getPendingLifecycleCommand(this.db, transactionId);
  }

  saveLifecycleCommand(record: LifecycleCommandRecord): void {
    lifecycleCommands.saveLifecycleCommand(this.db, record);
  }

  deleteLifecycleCommand(id: string): void {
    lifecycleCommands.deleteLifecycleCommand(this.db, id);
  }

  getReliabilityBaseline(
    entityId: string, category: ReliabilityCategory, role: EntityRole,
  ): ReliabilityState|undefined {
    const row = this.db.query<{stateJson: string}, [string, string, string]>(
      `SELECT state_json AS stateJson FROM reliability_score_baselines
       WHERE entity_id = ? AND category = ? AND role = ?`,
    ).get(entityId, category, role);
    return row ? JSON.parse(row.stateJson) as ReliabilityState : undefined;
  }

  saveReliabilityBaseline(state: ReliabilityState): void {
    this.db.query(`INSERT INTO reliability_score_baselines
      (entity_id, category, role, state_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(entity_id, category, role) DO NOTHING`).run(
      state.entityId, state.category, state.role, JSON.stringify(state),
    );
  }

  saveListing(listing: Listing): void {
    this.db.query(`INSERT INTO reliability_listings(id, listing_json) VALUES (?, ?)
      ON CONFLICT(id) DO UPDATE SET listing_json = excluded.listing_json`).run(
      listing.id, JSON.stringify(listing),
    );
  }

  listListings(): Listing[] {
    return this.db.query<{listingJson: string}, []>(
      'SELECT listing_json AS listingJson FROM reliability_listings ORDER BY id',
    ).all().map((row) => JSON.parse(row.listingJson) as Listing);
  }

  /** Archives and replaces the active events after an outcome correction. */
  replaceReliabilityEvents(transactionId: string, events: ReliabilityEvent[], at: string): void {
    const previous = this.listReliabilityEventsForTransaction(transactionId);
    this.db.query(`INSERT INTO reliability_event_revisions
      (transaction_id, events_json, revised_at) VALUES (?, ?, ?)`).run(
      transactionId, JSON.stringify(previous), at,
    );
    this.db.query('DELETE FROM reliability_events WHERE transaction_id = ?').run(transactionId);
    for (const event of events) this.insertReliabilityEvent(event);
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

  /**
   * KYC onboarding rows. Lane A mock KYC writes through these
   * accessors. Reliability scores are not part of this section.
   */

  /** Updates the frozen KYC status and tier. Wallets and roles stay. */
  updateEntityKyc(id: string, status: KycStatus, tier: KycTier): Entity {
    return kycRecords.updateEntityKyc(this.db, id, status, tier);
  }

  /** Returns the entity that owns a wallet, or undefined. */
  getWalletEntityId(wallet: string): string|undefined {
    return kycRecords.getWalletEntityId(this.db, wallet);
  }

  /** Inserts or replaces the KYC profile for one entity. */
  saveKycProfile(profile: KycProfile): KycProfile {
    return kycRecords.saveKycProfile(this.db, profile);
  }

  /** Returns the profile, or undefined when the entity has none. */
  getKycProfile(entityId: string): KycProfile|undefined {
    return kycRecords.getKycProfile(this.db, entityId);
  }

  /** Records that an entity used an identifier. Keeps the first time. */
  recordKycIdentifier(
    entityId: string,
    signal: KycReRegistrationSignal,
    value: string,
    at: string,
  ): void {
    kycRecords.recordKycIdentifier(this.db, entityId, signal, value, at);
  }

  /** Entities that have used an identifier, ordered by entity id. */
  listKycIdentifierEntityIds(
    signal: KycReRegistrationSignal, value: string,
  ): string[] {
    return kycRecords.listKycIdentifierEntityIds(this.db, signal, value);
  }

  /** Appends one status record. Ids are unique. */
  insertKycStatusRecord(record: KycStatusRecord): void {
    kycRecords.insertKycStatusRecord(this.db, record);
  }

  /** Status records for one entity, in the order they were saved. */
  listKycStatusRecords(entityId: string): KycStatusRecord[] {
    return kycRecords.listKycStatusRecords(this.db, entityId);
  }

  // ---- Contract lifecycle (lane A, migration 012) ----

  /** Registers the signing key and preprod address of an existing entity. */
  insertContractParty(party: ContractParty, createdAt: string): void {
    contractRecords.insertContractParty(this.db, party, createdAt);
  }

  getContractParty(entityId: string): ContractParty|undefined {
    return contractRecords.getContractParty(this.db, entityId);
  }

  getContract(id: string): Contract|undefined {
    return contractRecords.getContract(this.db, id);
  }

  listContractIds(options: {openOnly: boolean}): string[] {
    return contractRecords.listContractIds(this.db, options.openOnly);
  }

  /** Writes one contract state change atomically. Throws on a version conflict. */
  commitContract(change: ContractCommit): void {
    this.transaction(() => contractRecords.commitContract(this.db, change));
  }

  listOperations(contractId: string): EscrowOperation[] {
    return contractRecords.listOperations(this.db, contractId);
  }

  listPendingOperations(): EscrowOperation[] {
    return contractRecords.listPendingOperations(this.db);
  }

  /** Leases a pending escrow operation and counts the attempt before the external write. */
  claimOperation(id: string, owner: string, now: number, leaseUntil: number): EscrowOperation|undefined {
    return this.transaction(() => contractRecords.claimOperation(this.db, id, owner, now, leaseUntil));
  }

  releaseOperation(id: string, error: string, now: number): void {
    contractRecords.releaseOperation(this.db, id, error, now);
  }

  getEvidence(id: string): EvidenceRecord|undefined {
    return contractRecords.getEvidence(this.db, id);
  }

  getEvidenceContent(sha256: string): Uint8Array|undefined {
    return contractRecords.getEvidenceContent(this.db, sha256);
  }

  getProcessedAction(actionId: string): ProcessedAction|undefined {
    return contractRecords.getProcessedAction(this.db, actionId);
  }

  listContractAudit(contractId: string): ContractAuditRow[] {
    return contractRecords.listContractAudit(this.db, contractId);
  }

  /** Returns the first broken audit seq, or null when the hash chain is intact. */
  verifyContractAuditChain(): number|null {
    return contractRecords.verifyContractAuditChain(this.db);
  }

  listPendingContractPublications(): ReliabilityPublication[] {
    return contractRecords.listPendingPublications(this.db);
  }

  markContractPublicationPublished(id: string, publishedAt: number): void {
    contractRecords.markPublicationPublished(this.db, id, publishedAt);
  }

  // ---- Settlement anchors ----

  listUnanchoredFinalPublications(): FinalPublication[] {
    return anchorRecords.listUnanchoredFinalPublications(this.db);
  }

  getContractPublicationJson(id: string): string|null {
    return anchorRecords.getPublicationJson(this.db, id);
  }

  lastAnchorEntry(entityId: string): AnchorEntryRow|null {
    return anchorRecords.lastAnchorEntry(this.db, entityId);
  }

  insertAnchorEntries(entries: AnchorEntryRow[]): void {
    anchorRecords.insertAnchorEntries(this.db, entries);
  }

  listUnbatchedAnchorEntries(limit: number): AnchorEntryRow[] {
    return anchorRecords.listUnbatchedAnchorEntries(this.db, limit);
  }

  getOpenAnchorBatch(): AnchorBatchRow|null {
    return anchorRecords.getOpenAnchorBatch(this.db);
  }

  getAnchorBatch(id: string): AnchorBatchRow|null {
    return anchorRecords.getAnchorBatch(this.db, id);
  }

  createAnchorBatch(batch: Parameters<typeof anchorRecords.createAnchorBatch>[1]): void {
    anchorRecords.createAnchorBatch(this.db, batch);
  }

  markAnchorBatchSubmitted(id: string, at: number, note: string|null): void {
    anchorRecords.markAnchorBatchSubmitted(this.db, id, at, note);
  }

  markAnchorBatchConfirmed(id: string, evidence: {at: number; blockHeight: number; blockTime: number}): void {
    anchorRecords.markAnchorBatchConfirmed(this.db, id, evidence);
  }

  markAnchorBatchExpired(id: string, at: number, note: string): void {
    anchorRecords.markAnchorBatchExpired(this.db, id, at, note);
  }

  listAnchorEntriesForContract(contractId: string): AnchoredEntryView[] {
    return anchorRecords.listAnchorEntriesForContract(this.db, contractId);
  }

  listAnchorEntriesForEntity(entityId: string): AnchoredEntryView[] {
    return anchorRecords.listAnchorEntriesForEntity(this.db, entityId);
  }

  anchorCounts(): ReturnType<typeof anchorRecords.anchorCounts> {
    return anchorRecords.anchorCounts(this.db);
  }

  getPaperEscrow(ref: string): string|undefined {
    return contractRecords.getPaperEscrow(this.db, ref);
  }

  /** Saves a paper escrow. With `op`, records the applied operation in the same transaction. */
  savePaperEscrow(ref: string, json: string, op?: {idempotencyKey: string; kind: string; appliedAt: number}): void {
    this.transaction(() => {
      contractRecords.savePaperEscrow(this.db, ref, json);
      if (op) contractRecords.insertPaperEscrowOp(this.db, op.idempotencyKey, ref, op.kind, op.appliedAt);
    });
  }

  getPaperEscrowOp(idempotencyKey: string): string|undefined {
    return contractRecords.getPaperEscrowOp(this.db, idempotencyKey);
  }

  /** Paper clock offset in ms (paper time = system time + offset). */
  getPaperClockOffset(): number {
    return contractRecords.getPaperClockOffset(this.db);
  }

  /** Raises the paper clock offset. Paper time never goes back. */
  raisePaperClockOffset(offsetMs: number): void {
    contractRecords.raisePaperClockOffset(this.db, offsetMs);
  }
}
