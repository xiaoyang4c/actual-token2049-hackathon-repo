/**
 * @fileoverview Stored wallet accounts: sign-in challenges, wallet proofs,
 * sessions, and live deposits (migration 017). Read docs/wallets.md.
 */
import type {Database} from 'bun:sqlite';

export interface WalletChallengeRow {
  id: string;
  address: string;
  message: string;
  createdAt: number;
  expiresAt: number;
  usedAt: number|null;
}

export interface WalletProofRow {
  address: string;
  entityId: string;
  credentialKind: 'stake'|'payment';
  credentialHash: string;
  publicKeyHex: string;
  source: 'cip30'|'browser';
  walletName: string|null;
  challengeId: string;
  verifiedAt: string;
}

export interface SessionRow {
  tokenHash: string;
  entityId: string;
  address: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number|null;
}

export type LiveDepositStatus = 'pending'|'confirmed'|'unattributed'|'rolled_back';

export interface LiveDepositRow {
  txHash: string;
  outputIndex: number;
  unit: string;
  quantity: string;
  depositAddress: string;
  entityId: string|null;
  status: LiveDepositStatus;
  blockHeight: number|null;
  blockTime: number|null;
  firstSeenAt: number;
  confirmedAt: number|null;
  note: string|null;
}

export interface DepositSubmissionRow {
  txHash: string;
  entityId: string;
  fromAddress: string;
  amounts: Array<{unit: string; quantity: string}>;
  submittedAt: number;
}

const CHALLENGE_COLUMNS = 'id, address, message, created_at AS createdAt, expires_at AS expiresAt, used_at AS usedAt';
const PROOF_COLUMNS = `address, entity_id AS entityId, credential_kind AS credentialKind, credential_hash AS credentialHash,
  public_key_hex AS publicKeyHex, source, wallet_name AS walletName, challenge_id AS challengeId, verified_at AS verifiedAt`;
const SESSION_COLUMNS = 'token_hash AS tokenHash, entity_id AS entityId, address, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt';
const DEPOSIT_COLUMNS = `tx_hash AS txHash, output_index AS outputIndex, unit, quantity, deposit_address AS depositAddress,
  entity_id AS entityId, status, block_height AS blockHeight, block_time AS blockTime, first_seen_at AS firstSeenAt,
  confirmed_at AS confirmedAt, note`;

export function insertWalletChallenge(db: Database, row: Omit<WalletChallengeRow, 'usedAt'>): void {
  db.query('INSERT INTO reliability_wallet_challenges (id, address, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, row.address, row.message, row.createdAt, row.expiresAt);
}

export function getWalletChallenge(db: Database, id: string): WalletChallengeRow|undefined {
  return db.query<WalletChallengeRow, [string]>(`SELECT ${CHALLENGE_COLUMNS} FROM reliability_wallet_challenges WHERE id = ?`).get(id) ?? undefined;
}

/** Marks a challenge used. Returns false when another request used it first. */
export function useWalletChallenge(db: Database, id: string, at: number): boolean {
  return db.query('UPDATE reliability_wallet_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL').run(at, id).changes === 1;
}

/** Deletes expired challenges that no proof refers to. Returns the count of open ones left. */
export function pruneWalletChallenges(db: Database, now: number): number {
  db.query(`DELETE FROM reliability_wallet_challenges WHERE expires_at < ?
    AND id NOT IN (SELECT challenge_id FROM reliability_wallet_proofs)`).run(now);
  return db.query<{open: number}, [number]>('SELECT COUNT(*) AS open FROM reliability_wallet_challenges WHERE used_at IS NULL AND expires_at >= ?').get(now)?.open ?? 0;
}

export function insertWalletProof(db: Database, row: WalletProofRow): void {
  db.query(`INSERT INTO reliability_wallet_proofs (address, entity_id, credential_kind, credential_hash, public_key_hex,
    source, wallet_name, challenge_id, verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.address, row.entityId, row.credentialKind, row.credentialHash, row.publicKeyHex, row.source,
      row.walletName, row.challengeId, row.verifiedAt);
}

export function getWalletProofByCredential(db: Database, credentialHash: string): WalletProofRow|undefined {
  return db.query<WalletProofRow, [string]>(`SELECT ${PROOF_COLUMNS} FROM reliability_wallet_proofs WHERE credential_hash = ?`).get(credentialHash) ?? undefined;
}

export function listWalletProofs(db: Database, entityId: string): WalletProofRow[] {
  return db.query<WalletProofRow, [string]>(`SELECT ${PROOF_COLUMNS} FROM reliability_wallet_proofs WHERE entity_id = ? ORDER BY verified_at`).all(entityId);
}

/** Every proof, for deposit attribution. */
export function listAllWalletProofs(db: Database): WalletProofRow[] {
  return db.query<WalletProofRow, []>(`SELECT ${PROOF_COLUMNS} FROM reliability_wallet_proofs`).all();
}

export function insertSession(db: Database, row: Omit<SessionRow, 'revokedAt'>): void {
  db.query('INSERT INTO reliability_sessions (token_hash, entity_id, address, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(row.tokenHash, row.entityId, row.address, row.createdAt, row.expiresAt);
}

export function getSession(db: Database, tokenHash: string): SessionRow|undefined {
  return db.query<SessionRow, [string]>(`SELECT ${SESSION_COLUMNS} FROM reliability_sessions WHERE token_hash = ?`).get(tokenHash) ?? undefined;
}

export function revokeSession(db: Database, tokenHash: string, at: number): void {
  db.query('UPDATE reliability_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL').run(at, tokenHash);
}

/** Inserts a deposit output, or updates its status, block, and entity. */
export function upsertLiveDeposit(db: Database, row: LiveDepositRow): void {
  db.query(`INSERT INTO reliability_live_deposits (tx_hash, output_index, unit, quantity, deposit_address, entity_id, status,
      block_height, block_time, first_seen_at, confirmed_at, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tx_hash, output_index, unit) DO UPDATE SET
      entity_id = excluded.entity_id, status = excluded.status, block_height = excluded.block_height,
      block_time = excluded.block_time, confirmed_at = excluded.confirmed_at, note = excluded.note`)
    .run(row.txHash, row.outputIndex, row.unit, row.quantity, row.depositAddress, row.entityId, row.status,
      row.blockHeight, row.blockTime, row.firstSeenAt, row.confirmedAt, row.note);
}

export function listLiveDepositsForTx(db: Database, txHash: string): LiveDepositRow[] {
  return db.query<LiveDepositRow, [string]>(`SELECT ${DEPOSIT_COLUMNS} FROM reliability_live_deposits WHERE tx_hash = ? ORDER BY output_index, unit`).all(txHash);
}

export function listLiveDeposits(db: Database, filter: {entityId?: string; status?: LiveDepositStatus; limit?: number} = {}): LiveDepositRow[] {
  const where: string[] = [];
  const params: Array<string|number> = [];
  if (filter.entityId !== undefined) { where.push('entity_id = ?'); params.push(filter.entityId); }
  if (filter.status !== undefined) { where.push('status = ?'); params.push(filter.status); }
  params.push(filter.limit ?? 200);
  return db.query<LiveDepositRow, Array<string|number>>(`SELECT ${DEPOSIT_COLUMNS} FROM reliability_live_deposits
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY first_seen_at DESC, tx_hash, output_index LIMIT ?`).all(...params);
}

/** Confirmed totals for one entity, per unit, as decimal strings. */
export function confirmedDepositTotals(db: Database, entityId: string): Array<{unit: string; quantity: string}> {
  const rows = db.query<{unit: string; quantity: string}, [string]>(
    `SELECT unit, quantity FROM reliability_live_deposits WHERE entity_id = ? AND status = 'confirmed'`,
  ).all(entityId);
  const totals = new Map<string, bigint>();
  for (const row of rows) totals.set(row.unit, (totals.get(row.unit) ?? 0n) + BigInt(row.quantity));
  return [...totals].map(([unit, quantity]) => ({unit, quantity: quantity.toString()}));
}

export function insertDepositSubmission(db: Database, row: DepositSubmissionRow): void {
  db.query(`INSERT OR IGNORE INTO reliability_deposit_submissions (tx_hash, entity_id, from_address, amounts_json, submitted_at)
    VALUES (?, ?, ?, ?, ?)`).run(row.txHash, row.entityId, row.fromAddress, JSON.stringify(row.amounts), row.submittedAt);
}

export function listDepositSubmissions(db: Database, entityId: string, limit = 20): DepositSubmissionRow[] {
  return db.query<{txHash: string; entityId: string; fromAddress: string; amountsJson: string; submittedAt: number}, [string, number]>(
    `SELECT tx_hash AS txHash, entity_id AS entityId, from_address AS fromAddress, amounts_json AS amountsJson, submitted_at AS submittedAt
     FROM reliability_deposit_submissions WHERE entity_id = ? ORDER BY submitted_at DESC LIMIT ?`,
  ).all(entityId, limit).map(({amountsJson, ...row}) => ({...row, amounts: JSON.parse(amountsJson) as DepositSubmissionRow['amounts']}));
}
