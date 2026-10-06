/**
 * @fileoverview Queries for the reliability marketplace tables.
 * Domain types live in packages/reliability. This module only stores
 * and reads rows, following the conventions of the other query modules.
 */

import type {Database} from 'bun:sqlite';
import type {
  Entity, EntityRole, Listing, MarketplaceTransaction, Outcome,
  OutcomeState, ReliabilityCategory, ReliabilityEvent, ReliabilityOutcome,
  ReliabilityState, TermsDecision, TermsReasonCode, TermsVersion,
  TransactionType, VerificationMethod,
} from '../../reliability/src/types';
import {
  jsonText, requireFinite, requireOneOf, requiredRow, requireText,
} from './codecs';

const ROLES: readonly EntityRole[] = ['buyer', 'seller'];
const CATEGORIES: readonly ReliabilityCategory[] = [
  'compute', 'payment', 'fulfillment', 'delivery', 'sla', 'dispute',
];
const TRANSACTION_TYPES: readonly TransactionType[] = [
  'goods', 'service', 'invoice',
];
const OUTCOME_STATES: readonly OutcomeState[] = [
  'pending', 'successful', 'failed', 'disputed', 'cancelled', 'unresolved',
];
const VERIFICATION_METHODS: readonly VerificationMethod[] = [
  'lifecycle', 'payment-settlement', 'manual-review', 'unverified',
];
const EVENT_OUTCOMES: readonly ReliabilityOutcome[] = ['success', 'failure'];
const REASON_CODES: readonly TermsReasonCode[] = [
  'NEW_ENTITY', 'LOW_CONFIDENCE', 'STRONG_HISTORY', 'WEAK_HISTORY',
  'REPEAT_PAIR_DISCOUNT', 'KYC_LIMIT', 'POLICY_DEFAULT',
];

interface EntityRow {
  id: string;
  displayName: string;
  rolesJson: string;
  kycStatus: string;
  kycTier: string;
  createdAt: string;
}

function parseEntity(row: EntityRow, wallets: string[]): Entity {
  const roles: unknown = JSON.parse(row.rolesJson);
  if (!Array.isArray(roles)) throw new Error('roles must be a list');
  return {
    id: row.id,
    displayName: requireText(row.displayName, 'displayName'),
    wallets,
    kycStatus: requireOneOf(row.kycStatus, ['unverified', 'pending', 'verified', 'rejected'], 'kycStatus'),
    kycTier: requireOneOf(row.kycTier, ['none', 'basic', 'enhanced'], 'kycTier'),
    roles: roles.map((role) => requireOneOf(String(role), ROLES, 'role')),
    createdAt: requireText(row.createdAt, 'createdAt'),
  };
}

/** Inserts an entity and its wallets. Wallets must be new. */
export function insertEntity(db: Database, entity: Entity): Entity {
  db.query(`INSERT INTO reliability_entities
      (id, display_name, roles_json, kyc_status, kyc_tier, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
    requireText(entity.id, 'entity id'),
    requireText(entity.displayName, 'displayName'),
    jsonText(entity.roles.map((role) => requireOneOf(role, ROLES, 'role'))),
    requireText(entity.kycStatus, 'kycStatus'),
    requireText(entity.kycTier, 'kycTier'),
    requireText(entity.createdAt, 'createdAt'),
  );
  for (const wallet of entity.wallets) {
    addWallet(db, entity.id, wallet, entity.createdAt);
  }
  return requiredRow(getEntity(db, entity.id), 'entity');
}

/** Returns the entity, or undefined when `id` is absent. */
export function getEntity(db: Database, id: string): Entity|undefined {
  const row = db.query<EntityRow, [string]>(`SELECT
      id, display_name AS displayName, roles_json AS rolesJson,
      kyc_status AS kycStatus, kyc_tier AS kycTier, created_at AS createdAt
      FROM reliability_entities WHERE id = ?`).get(id);
  if (!row) return undefined;
  return parseEntity(row, listWallets(db, row.id));
}

/** Lists entities in id order. */
export function listEntities(db: Database): Entity[] {
  return db.query<EntityRow, []>(`SELECT
      id, display_name AS displayName, roles_json AS rolesJson,
      kyc_status AS kycStatus, kyc_tier AS kycTier, created_at AS createdAt
      FROM reliability_entities ORDER BY id`).all().map(
    (row) => parseEntity(row, listWallets(db, row.id)),
  );
}

/** Links one wallet to an entity. */
export function addWallet(
  db: Database, entityId: string, wallet: string, addedAt: string,
): void {
  db.query(`INSERT INTO reliability_wallets (wallet, entity_id, added_at)
      VALUES (?, ?, ?)`).run(
    requireText(wallet, 'wallet'), requireText(entityId, 'entityId'),
    requireText(addedAt, 'addedAt'),
  );
}

/** Lists wallets of one entity in wallet order. */
export function listWallets(db: Database, entityId: string): string[] {
  return db.query<{wallet: string}, [string]>(
    'SELECT wallet FROM reliability_wallets WHERE entity_id = ? ORDER BY wallet',
  ).all(entityId).map((row) => row.wallet);
}

function participantId(
  transaction: MarketplaceTransaction, role: EntityRole,
): string {
  const found = transaction.participants.find(
    (participant) => participant.role === role,
  );
  if (!found) throw new Error(`transaction needs a ${role}`);
  return found.entityId;
}

/** Inserts a transaction with its first terms version. */
export function insertTransaction(
  db: Database, transaction: MarketplaceTransaction,
): MarketplaceTransaction {
  db.query(`INSERT INTO reliability_transactions
      (id, type, buyer_id, seller_id, terms_json, terms_hash, value,
       created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    requireText(transaction.id, 'transaction id'),
    requireOneOf(transaction.type, TRANSACTION_TYPES, 'type'),
    participantId(transaction, 'buyer'),
    participantId(transaction, 'seller'),
    jsonText(transaction.terms),
    transaction.termsHash ?? null,
    transaction.value ?? null,
    requireText(transaction.createdAt, 'createdAt'),
    transaction.completedAt ?? null,
  );
  for (const termsVersion of transaction.versions) {
    insertTermsVersion(db, transaction.id, termsVersion);
  }
  return requiredRow(getTransaction(db, transaction.id), 'transaction');
}

interface TransactionRow {
  id: string;
  type: string;
  buyerId: string;
  sellerId: string;
  termsJson: string;
  termsHash: string|null;
  value: number|null;
  createdAt: string;
  completedAt: string|null;
}

function parseTransaction(row: TransactionRow): MarketplaceTransaction {
  return {
    id: row.id,
    type: requireOneOf(row.type, TRANSACTION_TYPES, 'type'),
    participants: [
      {entityId: requireText(row.buyerId, 'buyerId'), role: 'buyer'},
      {entityId: requireText(row.sellerId, 'sellerId'), role: 'seller'},
    ],
    terms: JSON.parse(row.termsJson),
    termsHash: row.termsHash ?? undefined,
    versions: [],
    value: row.value ?? undefined,
    createdAt: requireText(row.createdAt, 'createdAt'),
    completedAt: row.completedAt ?? undefined,
  };
}

/** Returns the transaction with versions, or undefined when absent. */
export function getTransaction(
  db: Database, id: string,
): MarketplaceTransaction|undefined {
  const row = db.query<TransactionRow, [string]>(`SELECT
      id, type, buyer_id AS buyerId, seller_id AS sellerId,
      terms_json AS termsJson, terms_hash AS termsHash, value,
      created_at AS createdAt, completed_at AS completedAt
      FROM reliability_transactions WHERE id = ?`).get(id);
  if (!row) return undefined;
  const transaction = parseTransaction(row);
  transaction.versions = listTermsVersions(db, id);
  return transaction;
}

/** Lists transactions with versions in id order. */
export function listTransactions(db: Database): MarketplaceTransaction[] {
  return db.query<TransactionRow, []>(`SELECT
      id, type, buyer_id AS buyerId, seller_id AS sellerId,
      terms_json AS termsJson, terms_hash AS termsHash, value,
      created_at AS createdAt, completed_at AS completedAt
      FROM reliability_transactions ORDER BY id`).all().map((row) => {
    const transaction = parseTransaction(row);
    transaction.versions = listTermsVersions(db, row.id);
    return transaction;
  });
}

/** Appends one terms version. Terms never change without a version. */
export function insertTermsVersion(
  db: Database, transactionId: string, version: TermsVersion,
): void {
  db.query(`INSERT INTO reliability_terms_versions
      (transaction_id, version, terms_json, reason, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(
    requireText(transactionId, 'transactionId'),
    requireFinite(version.version, 'version'),
    jsonText(version.terms),
    requireText(version.reason, 'reason'),
    requireText(version.createdAt, 'createdAt'),
  );
}

/** Lists terms versions in version order. */
export function listTermsVersions(
  db: Database, transactionId: string,
): TermsVersion[] {
  return db.query<{
    version: number; termsJson: string; reason: string; createdAt: string;
  }, [string]>(`SELECT version, terms_json AS termsJson, reason,
      created_at AS createdAt FROM reliability_terms_versions
      WHERE transaction_id = ? ORDER BY version`).all(transactionId).map(
    (row) => ({
      version: requireFinite(row.version, 'version'),
      terms: JSON.parse(row.termsJson),
      reason: requireText(row.reason, 'reason'),
      createdAt: requireText(row.createdAt, 'createdAt'),
    }),
  );
}

/** Stores the outcome of a transaction. One outcome per transaction. */
export function saveOutcome(db: Database, outcome: Outcome): Outcome {
  db.query(`INSERT INTO reliability_outcomes
      (transaction_id, state, evidence_json, verification_method,
       verification_confidence, resolver, resolve_by, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (transaction_id) DO UPDATE SET
      state = excluded.state, evidence_json = excluded.evidence_json,
      verification_method = excluded.verification_method,
      verification_confidence = excluded.verification_confidence,
      resolver = excluded.resolver, resolve_by = excluded.resolve_by,
      decided_at = excluded.decided_at`).run(
    requireText(outcome.transactionId, 'transactionId'),
    requireOneOf(outcome.state, OUTCOME_STATES, 'state'),
    jsonText(outcome.evidence),
    requireOneOf(
      outcome.verificationMethod, VERIFICATION_METHODS, 'verificationMethod',
    ),
    outcome.verificationConfidence ?? null,
    outcome.resolver ?? null,
    outcome.resolveBy ?? null,
    requireText(outcome.decidedAt, 'decidedAt'),
  );
  return requiredRow(getOutcome(db, outcome.transactionId), 'outcome');
}

interface OutcomeRow {
  transactionId: string;
  state: string;
  evidenceJson: string;
  verificationMethod: string;
  verificationConfidence: number|null;
  resolver: string|null;
  resolveBy: string|null;
  decidedAt: string;
}

function parseOutcome(row: OutcomeRow): Outcome {
  return {
    transactionId: row.transactionId,
    state: requireOneOf(row.state, OUTCOME_STATES, 'state'),
    evidence: JSON.parse(row.evidenceJson),
    verificationMethod: requireOneOf(
      row.verificationMethod, VERIFICATION_METHODS, 'verificationMethod',
    ),
    verificationConfidence: row.verificationConfidence ?? undefined,
    resolver: row.resolver ?? undefined,
    resolveBy: row.resolveBy ?? undefined,
    decidedAt: requireText(row.decidedAt, 'decidedAt'),
  };
}

/** Returns the outcome, or undefined when the transaction has none. */
export function getOutcome(
  db: Database, transactionId: string,
): Outcome|undefined {
  const row = db.query<OutcomeRow, [string]>(`SELECT
      transaction_id AS transactionId, state, evidence_json AS evidenceJson,
      verification_method AS verificationMethod,
      verification_confidence AS verificationConfidence,
      resolver, resolve_by AS resolveBy, decided_at AS decidedAt
      FROM reliability_outcomes WHERE transaction_id = ?`).get(transactionId);
  if (!row) return undefined;
  return parseOutcome(row);
}

/** Inserts one reliability event. Event ids are unique. */
export function insertReliabilityEvent(
  db: Database, event: ReliabilityEvent,
): void {
  db.query(`INSERT INTO reliability_events
      (id, transaction_id, entity_id, category, role, outcome, evidence_json,
       verification_method, verification_confidence, value, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    requireText(event.id, 'event id'),
    requireText(event.transactionId, 'transactionId'),
    requireText(event.entityId, 'entityId'),
    requireOneOf(event.category, CATEGORIES, 'category'),
    requireOneOf(event.role, ROLES, 'role'),
    requireOneOf(event.outcome, EVENT_OUTCOMES, 'outcome'),
    jsonText(event.evidence),
    requireOneOf(
      event.verificationMethod, VERIFICATION_METHODS, 'verificationMethod',
    ),
    event.verificationConfidence ?? null,
    event.value ?? null,
    requireText(event.createdAt, 'createdAt'),
  );
}

interface ReliabilityEventRow {
  id: string;
  transactionId: string;
  entityId: string;
  category: string;
  role: string;
  outcome: string;
  evidenceJson: string;
  verificationMethod: string;
  verificationConfidence: number|null;
  value: number|null;
  createdAt: string;
}

function parseReliabilityEvent(row: ReliabilityEventRow): ReliabilityEvent {
  return {
    id: row.id,
    transactionId: requireText(row.transactionId, 'transactionId'),
    entityId: requireText(row.entityId, 'entityId'),
    category: requireOneOf(row.category, CATEGORIES, 'category'),
    role: requireOneOf(row.role, ROLES, 'role'),
    outcome: requireOneOf(row.outcome, EVENT_OUTCOMES, 'outcome'),
    evidence: JSON.parse(row.evidenceJson),
    verificationMethod: requireOneOf(
      row.verificationMethod, VERIFICATION_METHODS, 'verificationMethod',
    ),
    verificationConfidence: row.verificationConfidence ?? undefined,
    value: row.value ?? undefined,
    createdAt: requireText(row.createdAt, 'createdAt'),
  };
}

const SELECT_EVENT = `SELECT
    id, transaction_id AS transactionId, entity_id AS entityId, category,
    role, outcome, evidence_json AS evidenceJson,
    verification_method AS verificationMethod,
    verification_confidence AS verificationConfidence, value,
    created_at AS createdAt FROM reliability_events`;

/** Lists events of one transaction in id order. */
export function listReliabilityEventsForTransaction(
  db: Database, transactionId: string,
): ReliabilityEvent[] {
  return db.query<ReliabilityEventRow, [string]>(
    `${SELECT_EVENT} WHERE transaction_id = ? ORDER BY id`,
  ).all(transactionId).map(parseReliabilityEvent);
}

/** Lists events of one entity, category, and role in id order. */
export function listReliabilityEventsForState(
  db: Database, entityId: string, category: ReliabilityCategory,
  role: EntityRole,
): ReliabilityEvent[] {
  return db.query<ReliabilityEventRow, [string, string, string]>(
    `${SELECT_EVENT} WHERE entity_id = ? AND category = ? AND role = ?
     ORDER BY id`,
  ).all(entityId, category, role).map(parseReliabilityEvent);
}

/** Stores one per-role posterior. Replaces the previous triple. */
export function saveReliabilityState(
  db: Database, state: ReliabilityState,
): ReliabilityState {
  db.query(`INSERT INTO reliability_state
      (entity_id, category, role, alpha, beta, event_count, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (entity_id, category, role) DO UPDATE SET
      alpha = excluded.alpha, beta = excluded.beta,
      event_count = excluded.event_count, updated_at = excluded.updated_at`).run(
    requireText(state.entityId, 'entityId'),
    requireOneOf(state.category, CATEGORIES, 'category'),
    requireOneOf(state.role, ROLES, 'role'),
    requireFinite(state.alpha, 'alpha'),
    requireFinite(state.beta, 'beta'),
    requireFinite(state.eventCount, 'eventCount'),
    requireText(state.updatedAt, 'updatedAt'),
  );
  return requiredRow(
    getReliabilityState(db, state.entityId, state.category, state.role),
    'reliability state',
  );
}

interface ReliabilityStateRow {
  entityId: string;
  category: string;
  role: string;
  alpha: number;
  beta: number;
  eventCount: number;
  updatedAt: string;
}

function parseReliabilityState(row: ReliabilityStateRow): ReliabilityState {
  return {
    entityId: row.entityId,
    category: requireOneOf(row.category, CATEGORIES, 'category'),
    role: requireOneOf(row.role, ROLES, 'role'),
    alpha: requireFinite(row.alpha, 'alpha'),
    beta: requireFinite(row.beta, 'beta'),
    eventCount: requireFinite(row.eventCount, 'eventCount'),
    updatedAt: requireText(row.updatedAt, 'updatedAt'),
  };
}

const SELECT_STATE = `SELECT
    entity_id AS entityId, category, role, alpha, beta,
    event_count AS eventCount, updated_at AS updatedAt
    FROM reliability_state`;

/** Returns one posterior, or undefined when the triple is absent. */
export function getReliabilityState(
  db: Database, entityId: string, category: ReliabilityCategory,
  role: EntityRole,
): ReliabilityState|undefined {
  const row = db.query<ReliabilityStateRow, [string, string, string]>(
    `${SELECT_STATE} WHERE entity_id = ? AND category = ? AND role = ?`,
  ).get(entityId, category, role);
  if (!row) return undefined;
  return parseReliabilityState(row);
}

/** Lists posteriors in entity, category, and role order. */
export function listReliabilityStates(db: Database): ReliabilityState[] {
  return db.query<ReliabilityStateRow, []>(
    `${SELECT_STATE} ORDER BY entity_id, category, role`,
  ).all().map(parseReliabilityState);
}

/** Inserts one terms and fee decision and returns its row id. */
export function insertTermsDecision(
  db: Database, decision: TermsDecision,
): number {
  const result = db.query(`INSERT INTO reliability_terms_decisions
      (entity_id, category, inputs_json, terms_json, buyer_fee_bps,
       seller_fee_bps, reason_code, policy_version, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    requireText(decision.entityId, 'entityId'),
    requireOneOf(decision.category, CATEGORIES, 'category'),
    jsonText(decision.inputs),
    jsonText(decision.terms),
    requireFinite(decision.buyerFeeBps, 'buyerFeeBps'),
    requireFinite(decision.sellerFeeBps, 'sellerFeeBps'),
    requireOneOf(decision.reasonCode, REASON_CODES, 'reasonCode'),
    requireText(decision.policyVersion, 'policyVersion'),
    requireText(decision.decidedAt, 'decidedAt'),
  );
  const id = result.lastInsertRowid;
  if (typeof id !== 'number') throw new Error('terms decision was not stored');
  return id;
}

interface TermsDecisionRow {
  id: number;
  entityId: string;
  category: string;
  inputsJson: string;
  termsJson: string;
  buyerFeeBps: number;
  sellerFeeBps: number;
  reasonCode: string;
  policyVersion: string;
  decidedAt: string;
}

function parseTermsDecision(row: TermsDecisionRow): TermsDecision {
  const terms: unknown = JSON.parse(row.termsJson);
  if (typeof terms !== 'object' || terms === null) {
    throw new Error('terms must be an object');
  }
  return {
    entityId: row.entityId,
    category: requireOneOf(row.category, CATEGORIES, 'category'),
    inputs: JSON.parse(row.inputsJson),
    terms: terms as TermsDecision['terms'],
    buyerFeeBps: requireFinite(row.buyerFeeBps, 'buyerFeeBps'),
    sellerFeeBps: requireFinite(row.sellerFeeBps, 'sellerFeeBps'),
    reasonCode: requireOneOf(row.reasonCode, REASON_CODES, 'reasonCode'),
    policyVersion: requireText(row.policyVersion, 'policyVersion'),
    decidedAt: requireText(row.decidedAt, 'decidedAt'),
  };
}

/** Lists decisions for one entity and category, oldest first. */
export function listTermsDecisions(
  db: Database, entityId: string, category: ReliabilityCategory,
): TermsDecision[] {
  return db.query<TermsDecisionRow, [string, string]>(`SELECT
      id, entity_id AS entityId, category, inputs_json AS inputsJson,
      terms_json AS termsJson, buyer_fee_bps AS buyerFeeBps,
      seller_fee_bps AS sellerFeeBps, reason_code AS reasonCode,
      policy_version AS policyVersion, decided_at AS decidedAt
      FROM reliability_terms_decisions
      WHERE entity_id = ? AND category = ? ORDER BY id`).all(
    entityId, category,
  ).map(parseTermsDecision);
}

/** Builds a listing row from a domain listing. Used by the seed helper. */
export function listingKey(listing: Listing): string {
  return requireText(listing.id, 'listing id');
}
