/**
 * @fileoverview Contract lifecycle records (lane A). Schema lives in
 * 012_contract_lifecycle.sql. The AgentStore facade wraps each write
 * that needs atomicity in one transaction.
 */

import type {Database} from 'bun:sqlite';
import {canonicalize} from '../../reliability/src/contract-lifecycle/canonical-json';
import {sha256Hex} from '../../reliability/src/contract-lifecycle/hashing';
import {
  ContractConflictError, type ContractAuditEntry, type ContractAuditRow, type ContractCommit,
  type EscrowOperation, type ProcessedAction, type ReliabilityPublication,
} from '../../reliability/src/contract-lifecycle/ports';
import type {
  Contract, ContractParty, EvidenceRecord,
} from '../../reliability/src/contract-lifecycle/types';
import {jsonText, requireText} from './codecs';

/** prevHash of the first audit row. */
const GENESIS_HASH = '0'.repeat(64);

// ---- Parties ----

export function insertContractParty(db: Database, party: ContractParty, createdAt: string): void {
  db.query(`INSERT INTO contract_parties (entity_id, public_key_hex, cardano_address, created_at)
      VALUES (?, ?, ?, ?)`).run(
    requireText(party.id, 'entity id'),
    requireText(party.publicKeyHex, 'publicKeyHex'),
    requireText(party.cardanoAddress, 'cardanoAddress'),
    requireText(createdAt, 'createdAt'),
  );
}

export function getContractParty(db: Database, entityId: string): ContractParty|undefined {
  const row = db.query<{id: string; publicKeyHex: string; cardanoAddress: string}, [string]>(`SELECT
      entity_id AS id, public_key_hex AS publicKeyHex, cardano_address AS cardanoAddress
      FROM contract_parties WHERE entity_id = ?`).get(entityId);
  return row ?? undefined;
}

// ---- Contracts ----

export function getContract(db: Database, id: string): Contract|undefined {
  const row = db.query<{json: string}, [string]>('SELECT json FROM contract_contracts WHERE id = ?').get(id);
  return row ? (JSON.parse(row.json) as Contract) : undefined;
}

export function listContractIds(db: Database, openOnly: boolean): string[] {
  const sql = openOnly ?
    'SELECT id FROM contract_contracts WHERE open = 1 ORDER BY rowid' :
    'SELECT id FROM contract_contracts ORDER BY rowid';
  return db.query<{id: string}, []>(sql).all().map((row) => row.id);
}

/** Writes one state change. Run inside a transaction. */
export function commitContract(db: Database, change: ContractCommit): void {
  const contract = change.contract;
  const open = change.open ? 1 : 0;
  if (change.isNew) {
    contract.version = 1;
    db.query(`INSERT INTO contract_contracts (id, json, version, mode, open, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(contract.id, JSON.stringify(contract), contract.version, contract.mode, open, change.now);
  } else {
    const expected = contract.version;
    contract.version = expected + 1;
    const result = db.query(`UPDATE contract_contracts SET json = ?, version = ?, open = ?, updated_at = ?
        WHERE id = ? AND version = ?`).run(JSON.stringify(contract), contract.version, open, change.now, contract.id, expected);
    if (result.changes !== 1) {
      contract.version = expected;
      throw new ContractConflictError(contract.id);
    }
  }
  for (const entry of change.audits) appendAudit(db, entry);
  const insertOperation = db.query(`INSERT INTO contract_operations
      (id, contract_id, milestone_id, tranche_id, kind, idempotency_key, payload_json, status, attempts, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`);
  for (const operation of change.newOperations) {
    insertOperation.run(
      operation.id, operation.contractId, operation.milestoneId, operation.trancheId, operation.kind,
      operation.idempotencyKey, jsonText(operation.payload), operation.createdAt, operation.createdAt,
    );
  }
  const updateOperation = db.query(`UPDATE contract_operations SET status = ?,
      result_json = COALESCE(?, result_json), last_error = CASE WHEN ? THEN ? ELSE last_error END,
      lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`);
  for (const update of change.operationUpdates) {
    updateOperation.run(
      update.status, update.result ? jsonText(update.result) : null, update.lastError !== undefined ? 1 : 0,
      update.lastError ?? null, change.now, update.id,
    );
  }
  const insertContent = db.query(`INSERT INTO contract_evidence_content (sha256, content, size)
      VALUES (?, ?, ?) ON CONFLICT (sha256) DO NOTHING`);
  const insertEvidence = db.query(`INSERT INTO contract_evidence (id, contract_id, milestone_id, sha256, json)
      VALUES (?, ?, ?, ?, ?)`);
  for (const item of change.evidence) {
    if (sha256Hex(item.content) !== item.record.sha256) throw new Error(`evidence ${item.record.id} does not match its hash`);
    insertContent.run(item.record.sha256, item.content, item.content.byteLength);
    insertEvidence.run(item.record.id, item.record.contractId, item.record.milestoneId, item.record.sha256, JSON.stringify(item.record));
  }
  const insertPublication = db.query(`INSERT INTO contract_publications (id, contract_id, milestone_id, json, created_at)
      VALUES (?, ?, ?, ?, ?)`);
  for (const publication of change.publications) {
    insertPublication.run(publication.id, publication.contractId, publication.milestoneId, JSON.stringify(publication), publication.createdAt);
  }
  if (change.action) {
    db.query(`INSERT INTO contract_actions (action_id, contract_id, party_id, bytes_sha256, processed_at)
        VALUES (?, ?, ?, ?, ?)`).run(
      change.action.actionId, change.action.contractId, change.action.partyId, change.action.bytesSha256, change.action.processedAt,
    );
  }
}

// ---- Audit ----

function auditHash(prevHash: string, entry: ContractAuditEntry): string {
  return sha256Hex(prevHash + canonicalize({...entry}));
}

function appendAudit(db: Database, entry: ContractAuditEntry): void {
  const last = db.query<{hash: string}, []>('SELECT hash FROM contract_audit ORDER BY seq DESC LIMIT 1').get();
  const prevHash = last?.hash ?? GENESIS_HASH;
  // Round-trip through JSON so the stored details hash the same way on read.
  const normalized: ContractAuditEntry = {...entry, details: JSON.parse(JSON.stringify(entry.details)) as ContractAuditEntry['details']};
  db.query(`INSERT INTO contract_audit
      (at, contract_id, milestone_id, event, from_state, to_state, actor, mode, details_json, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    normalized.at, normalized.contractId, normalized.milestoneId, normalized.event, normalized.fromState,
    normalized.toState, normalized.actor, normalized.mode, JSON.stringify(normalized.details), prevHash,
    auditHash(prevHash, normalized),
  );
}

interface AuditRowShape {
  seq: number;
  at: number;
  contractId: string;
  milestoneId: string|null;
  event: string;
  fromState: string|null;
  toState: string|null;
  actor: string;
  mode: 'paper'|'live';
  detailsJson: string;
  prevHash: string;
  hash: string;
}

const AUDIT_COLUMNS = `seq, at, contract_id AS contractId, milestone_id AS milestoneId, event,
    from_state AS fromState, to_state AS toState, actor, mode, details_json AS detailsJson,
    prev_hash AS prevHash, hash`;

function parseAudit(row: AuditRowShape): ContractAuditRow {
  const {detailsJson, ...rest} = row;
  return {...rest, details: JSON.parse(detailsJson) as ContractAuditRow['details']};
}

export function listContractAudit(db: Database, contractId: string): ContractAuditRow[] {
  return db.query<AuditRowShape, [string]>(`SELECT ${AUDIT_COLUMNS} FROM contract_audit
      WHERE contract_id = ? ORDER BY seq`).all(contractId).map(parseAudit);
}

/** Recomputes the hash chain. Returns the first broken seq, or null when intact. */
export function verifyContractAuditChain(db: Database): number|null {
  let previous = GENESIS_HASH;
  for (const row of db.query<AuditRowShape, []>(`SELECT ${AUDIT_COLUMNS} FROM contract_audit ORDER BY seq`).all()) {
    const {seq, prevHash, hash, ...entry} = parseAudit(row);
    if (prevHash !== previous || auditHash(previous, entry) !== hash) return seq;
    previous = hash;
  }
  return null;
}

// ---- Operations ----

interface OperationRowShape {
  id: string;
  contractId: string;
  milestoneId: string;
  trancheId: string;
  kind: EscrowOperation['kind'];
  idempotencyKey: string;
  payloadJson: string;
  status: EscrowOperation['status'];
  attempts: number;
  lastError: string|null;
  resultJson: string|null;
  leaseOwner: string|null;
  leaseUntil: number|null;
  createdAt: number;
  updatedAt: number;
}

const OPERATION_COLUMNS = `id, contract_id AS contractId, milestone_id AS milestoneId, tranche_id AS trancheId,
    kind, idempotency_key AS idempotencyKey, payload_json AS payloadJson, status, attempts,
    last_error AS lastError, result_json AS resultJson, lease_owner AS leaseOwner,
    lease_until AS leaseUntil, created_at AS createdAt, updated_at AS updatedAt`;

function parseOperation(row: OperationRowShape): EscrowOperation {
  const {payloadJson, resultJson, ...rest} = row;
  return {
    ...rest,
    payload: JSON.parse(payloadJson) as EscrowOperation['payload'],
    result: resultJson === null ? null : JSON.parse(resultJson) as EscrowOperation['result'],
  };
}

export function listOperations(db: Database, contractId: string): EscrowOperation[] {
  return db.query<OperationRowShape, [string]>(`SELECT ${OPERATION_COLUMNS} FROM contract_operations
      WHERE contract_id = ? ORDER BY created_at, rowid`).all(contractId).map(parseOperation);
}

export function listPendingOperations(db: Database): EscrowOperation[] {
  return db.query<OperationRowShape, []>(`SELECT ${OPERATION_COLUMNS} FROM contract_operations
      WHERE status = 'pending' ORDER BY created_at, rowid`).all().map(parseOperation);
}

/** Leases a pending operation and counts the attempt. Run inside a transaction. */
export function claimOperation(
  db: Database, id: string, owner: string, now: number, leaseUntil: number,
): EscrowOperation|undefined {
  const row = db.query<OperationRowShape, [string]>(`SELECT ${OPERATION_COLUMNS} FROM contract_operations WHERE id = ?`).get(id);
  if (!row || row.status !== 'pending') return undefined;
  if (row.leaseUntil !== null && row.leaseUntil > now && row.leaseOwner !== owner) return undefined;
  db.query(`UPDATE contract_operations SET attempts = attempts + 1, lease_owner = ?, lease_until = ?,
      updated_at = ? WHERE id = ?`).run(owner, leaseUntil, now, id);
  return parseOperation(row);
}

export function releaseOperation(db: Database, id: string, error: string, now: number): void {
  db.query(`UPDATE contract_operations SET last_error = ?, lease_owner = NULL, lease_until = NULL,
      updated_at = ? WHERE id = ?`).run(error, now, id);
}

// ---- Evidence and actions ----

export function getEvidence(db: Database, id: string): EvidenceRecord|undefined {
  const row = db.query<{json: string}, [string]>('SELECT json FROM contract_evidence WHERE id = ?').get(id);
  return row ? (JSON.parse(row.json) as EvidenceRecord) : undefined;
}

export function getEvidenceContent(db: Database, sha256: string): Uint8Array|undefined {
  const row = db.query<{content: Uint8Array}, [string]>('SELECT content FROM contract_evidence_content WHERE sha256 = ?').get(sha256);
  return row ? new Uint8Array(row.content) : undefined;
}

export function getProcessedAction(db: Database, actionId: string): ProcessedAction|undefined {
  const row = db.query<ProcessedAction, [string]>(`SELECT action_id AS actionId, contract_id AS contractId,
      party_id AS partyId, bytes_sha256 AS bytesSha256, processed_at AS processedAt
      FROM contract_actions WHERE action_id = ?`).get(actionId);
  return row ?? undefined;
}

// ---- Reliability outbox ----

export function listPendingPublications(db: Database): ReliabilityPublication[] {
  return db.query<{json: string}, []>(`SELECT json FROM contract_publications
      WHERE published_at IS NULL ORDER BY created_at, rowid`).all()
    .map((row) => JSON.parse(row.json) as ReliabilityPublication);
}

export function markPublicationPublished(db: Database, id: string, publishedAt: number): void {
  db.query('UPDATE contract_publications SET published_at = ? WHERE id = ?').run(publishedAt, id);
}

// ---- Paper escrow and clock ----

export function getPaperEscrow(db: Database, ref: string): string|undefined {
  return db.query<{json: string}, [string]>('SELECT json FROM contract_paper_escrows WHERE ref = ?').get(ref)?.json;
}

export function savePaperEscrow(db: Database, ref: string, json: string): void {
  db.query(`INSERT INTO contract_paper_escrows (ref, json) VALUES (?, ?)
      ON CONFLICT (ref) DO UPDATE SET json = excluded.json`).run(ref, json);
}

export function getPaperEscrowOp(db: Database, idempotencyKey: string): string|undefined {
  return db.query<{ref: string}, [string]>('SELECT ref FROM contract_paper_escrow_ops WHERE idempotency_key = ?')
    .get(idempotencyKey)?.ref;
}

export function insertPaperEscrowOp(db: Database, idempotencyKey: string, ref: string, kind: string, appliedAt: number): void {
  db.query(`INSERT INTO contract_paper_escrow_ops (idempotency_key, ref, kind, applied_at)
      VALUES (?, ?, ?, ?)`).run(idempotencyKey, ref, kind, appliedAt);
}

/** Paper clock offset in ms. Zero when the clock was never moved. */
export function getPaperClockOffset(db: Database): number {
  return db.query<{offsetMs: number}, []>('SELECT offset_ms AS offsetMs FROM contract_paper_clock WHERE id = 1').get()?.offsetMs ?? 0;
}

/** Raises the offset. A smaller value is ignored, so paper time never goes back. */
export function raisePaperClockOffset(db: Database, offsetMs: number): void {
  db.query(`INSERT INTO contract_paper_clock (id, offset_ms) VALUES (1, ?)
      ON CONFLICT (id) DO UPDATE SET offset_ms = MAX(offset_ms, excluded.offset_ms)`).run(Math.max(0, Math.floor(offsetMs)));
}
