/**
 * @fileoverview Stored settlement anchors: per-company chain entries and the
 * Cardano batch transactions that carry their fingerprints. Read
 * services/reliability/anchors.ts for the hashing and the batch rules.
 */
import type {Database} from 'bun:sqlite';

/** Outcome states that end a milestone. Only these records are anchored. */
export const FINAL_OUTCOME_STATES = ['successful', 'failed', 'cancelled', 'unresolved'] as const;

export interface FinalPublication {
  id: string;
  contractId: string;
  milestoneId: string;
  /** The stored publication JSON. The record fingerprint is taken over its canonical form. */
  json: string;
}

export interface AnchorEntryRow {
  entryHash: string;
  entityId: string;
  seq: number;
  prevHash: string;
  recordHash: string;
  publicationId: string;
  contractId: string;
  milestoneId: string;
  batchId: string|null;
  createdAt: number;
}

export type AnchorBatchStatus = 'prepared'|'submitted'|'confirmed'|'expired';

export interface AnchorBatchRow {
  id: string;
  status: AnchorBatchStatus;
  txHash: string;
  txCbor: string;
  invalidHereafter: number;
  entryHashes: string[];
  createdAt: number;
  submittedAt: number|null;
  confirmedAt: number|null;
  blockHeight: number|null;
  blockTime: number|null;
  note: string|null;
}

/** An entry with the batch that carries it, for the read views. */
export interface AnchoredEntryView extends AnchorEntryRow {
  batchStatus: AnchorBatchStatus|null;
  txHash: string|null;
  blockHeight: number|null;
  blockTime: number|null;
}

const ENTRY_COLUMNS = `e.entry_hash AS entryHash, e.entity_id AS entityId, e.seq, e.prev_hash AS prevHash,
  e.record_hash AS recordHash, e.publication_id AS publicationId, e.contract_id AS contractId,
  e.milestone_id AS milestoneId, e.batch_id AS batchId, e.created_at AS createdAt`;
const VIEW_COLUMNS = `${ENTRY_COLUMNS}, b.status AS batchStatus, b.tx_hash AS txHash, b.block_height AS blockHeight, b.block_time AS blockTime`;

type BatchRecord = Omit<AnchorBatchRow, 'entryHashes'>&{entryHashesJson: string};
const BATCH_COLUMNS = `id, status, tx_hash AS txHash, tx_cbor AS txCbor, invalid_hereafter AS invalidHereafter,
  entry_hashes_json AS entryHashesJson, created_at AS createdAt, submitted_at AS submittedAt,
  confirmed_at AS confirmedAt, block_height AS blockHeight, block_time AS blockTime, note`;
const toBatch = ({entryHashesJson, ...row}: BatchRecord): AnchorBatchRow => ({...row, entryHashes: JSON.parse(entryHashesJson) as string[]});

/** Final publications with no anchor entries yet, oldest first. */
export function listUnanchoredFinalPublications(db: Database): FinalPublication[] {
  return db.query<FinalPublication, []>(`SELECT p.id, p.contract_id AS contractId, p.milestone_id AS milestoneId, p.json
    FROM contract_publications p
    WHERE json_extract(p.json, '$.outcome.state') IN (${FINAL_OUTCOME_STATES.map((state) => `'${state}'`).join(', ')})
      AND NOT EXISTS (SELECT 1 FROM reliability_anchor_entries e WHERE e.publication_id = p.id)
    ORDER BY p.created_at, p.id`).all();
}

export function getPublicationJson(db: Database, id: string): string|null {
  return db.query<{json: string}, [string]>('SELECT json FROM contract_publications WHERE id = ?').get(id)?.json ?? null;
}

export function lastAnchorEntry(db: Database, entityId: string): AnchorEntryRow|null {
  return db.query<AnchorEntryRow, [string]>(`SELECT ${ENTRY_COLUMNS} FROM reliability_anchor_entries e
    WHERE e.entity_id = ? ORDER BY e.seq DESC LIMIT 1`).get(entityId) ?? null;
}

/** Appends entries. The unique (entity, seq) key refuses a fork in a company chain. */
export function insertAnchorEntries(db: Database, entries: AnchorEntryRow[]): void {
  const insert = db.query(`INSERT INTO reliability_anchor_entries
    (entry_hash, entity_id, seq, prev_hash, record_hash, publication_id, contract_id, milestone_id, batch_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`);
  db.transaction(() => {
    for (const entry of entries) {
      insert.run(entry.entryHash, entry.entityId, entry.seq, entry.prevHash, entry.recordHash,
        entry.publicationId, entry.contractId, entry.milestoneId, entry.createdAt);
    }
  })();
}

export function listUnbatchedAnchorEntries(db: Database, limit: number): AnchorEntryRow[] {
  return db.query<AnchorEntryRow, [number]>(`SELECT ${ENTRY_COLUMNS} FROM reliability_anchor_entries e
    WHERE e.batch_id IS NULL ORDER BY e.created_at, e.entity_id, e.seq LIMIT ?`).all(limit);
}

export function getOpenAnchorBatch(db: Database): AnchorBatchRow|null {
  const row = db.query<BatchRecord, []>(`SELECT ${BATCH_COLUMNS} FROM reliability_anchor_batches
    WHERE status IN ('prepared', 'submitted') LIMIT 1`).get();
  return row ? toBatch(row) : null;
}

export function getAnchorBatch(db: Database, id: string): AnchorBatchRow|null {
  const row = db.query<BatchRecord, [string]>(`SELECT ${BATCH_COLUMNS} FROM reliability_anchor_batches WHERE id = ?`).get(id);
  return row ? toBatch(row) : null;
}

/**
 * Saves a signed batch transaction and assigns its entries, before anything
 * is sent. Throws, and saves nothing, if an entry is already in a batch.
 */
export function createAnchorBatch(db: Database, batch: Omit<AnchorBatchRow, 'status'|'submittedAt'|'confirmedAt'|'blockHeight'|'blockTime'|'note'>): void {
  db.transaction(() => {
    db.query(`INSERT INTO reliability_anchor_batches
      (id, status, tx_hash, tx_cbor, invalid_hereafter, entry_hashes_json, created_at) VALUES (?, 'prepared', ?, ?, ?, ?, ?)`)
      .run(batch.id, batch.txHash, batch.txCbor, batch.invalidHereafter, JSON.stringify(batch.entryHashes), batch.createdAt);
    const assign = db.query('UPDATE reliability_anchor_entries SET batch_id = ? WHERE entry_hash = ? AND batch_id IS NULL');
    for (const hash of batch.entryHashes) {
      if (assign.run(batch.id, hash).changes !== 1) throw new Error(`anchor entry ${hash} is missing or already in a batch`);
    }
  })();
}

export function markAnchorBatchSubmitted(db: Database, id: string, at: number, note: string|null): void {
  db.query(`UPDATE reliability_anchor_batches SET status = 'submitted', submitted_at = COALESCE(submitted_at, ?), note = ?
    WHERE id = ? AND status IN ('prepared', 'submitted')`).run(at, note, id);
}

export function markAnchorBatchConfirmed(db: Database, id: string, evidence: {at: number; blockHeight: number; blockTime: number}): void {
  db.query(`UPDATE reliability_anchor_batches SET status = 'confirmed', confirmed_at = ?, block_height = ?, block_time = ?, note = NULL
    WHERE id = ? AND status IN ('prepared', 'submitted')`).run(evidence.at, evidence.blockHeight, evidence.blockTime, id);
}

/** Ends a batch that can no longer reach the chain, and frees its entries for the next batch. */
export function markAnchorBatchExpired(db: Database, id: string, at: number, note: string): void {
  db.transaction(() => {
    db.query(`UPDATE reliability_anchor_batches SET status = 'expired', confirmed_at = NULL, note = ?
      WHERE id = ? AND status IN ('prepared', 'submitted')`).run(`${note} (at ${new Date(at).toISOString()})`, id);
    db.query('UPDATE reliability_anchor_entries SET batch_id = NULL WHERE batch_id = ?').run(id);
  })();
}

export function listAnchorEntriesForContract(db: Database, contractId: string): AnchoredEntryView[] {
  return db.query<AnchoredEntryView, [string]>(`SELECT ${VIEW_COLUMNS} FROM reliability_anchor_entries e
    LEFT JOIN reliability_anchor_batches b ON b.id = e.batch_id
    WHERE e.contract_id = ? ORDER BY e.created_at, e.entity_id`).all(contractId);
}

export function listAnchorEntriesForEntity(db: Database, entityId: string): AnchoredEntryView[] {
  return db.query<AnchoredEntryView, [string]>(`SELECT ${VIEW_COLUMNS} FROM reliability_anchor_entries e
    LEFT JOIN reliability_anchor_batches b ON b.id = e.batch_id
    WHERE e.entity_id = ? ORDER BY e.seq`).all(entityId);
}

export function anchorCounts(db: Database): {entries: number; unbatched: number; confirmed: number; batches: {[status: string]: number}} {
  const one = (sql: string) => db.query<{n: number}, []>(sql).get()?.n ?? 0;
  const batches = Object.fromEntries(db.query<{status: string; n: number}, []>(
    'SELECT status, COUNT(*) AS n FROM reliability_anchor_batches GROUP BY status').all().map((row) => [row.status, row.n]));
  return {
    entries: one('SELECT COUNT(*) AS n FROM reliability_anchor_entries'),
    unbatched: one('SELECT COUNT(*) AS n FROM reliability_anchor_entries WHERE batch_id IS NULL'),
    confirmed: one(`SELECT COUNT(*) AS n FROM reliability_anchor_entries e JOIN reliability_anchor_batches b ON b.id = e.batch_id
      WHERE b.status = 'confirmed'`),
    batches,
  };
}
