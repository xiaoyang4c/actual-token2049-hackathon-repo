-- Lane A contract lifecycle (templates, milestones, tranche escrows, tiered disputes).
-- File name: 012_contract_lifecycle.sql. The next free migration number is 013.
-- Read docs/contract-lifecycle.md.

-- Signing key and preprod address of a reliability entity.
CREATE TABLE contract_parties (
  entity_id TEXT PRIMARY KEY REFERENCES reliability_entities (id),
  public_key_hex TEXT NOT NULL CHECK (length(public_key_hex) = 64),
  cardano_address TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- One row per contract. `json` is the aggregate. `version` is the optimistic lock.
CREATE TABLE contract_contracts (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL CHECK (json_valid(json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  open INTEGER NOT NULL CHECK (open IN (0, 1)),
  updated_at INTEGER NOT NULL
);

CREATE INDEX contract_contracts_by_open ON contract_contracts (open, id);

-- Append-only audit log with a hash chain. Triggers block UPDATE and DELETE.
-- No row is ever deleted, so a plain INTEGER PRIMARY KEY only grows.
CREATE TABLE contract_audit (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  contract_id TEXT NOT NULL,
  milestone_id TEXT,
  event TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT,
  actor TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

CREATE INDEX contract_audit_by_contract ON contract_audit (contract_id, seq);

CREATE TRIGGER contract_audit_no_update BEFORE UPDATE ON contract_audit
BEGIN
  SELECT RAISE(ABORT, 'contract_audit is append-only');
END;

CREATE TRIGGER contract_audit_no_delete BEFORE DELETE ON contract_audit
BEGIN
  SELECT RAISE(ABORT, 'contract_audit is append-only');
END;

-- Journal of escrow writes. A row exists before the external write is sent.
CREATE TABLE contract_operations (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contract_contracts (id),
  milestone_id TEXT NOT NULL,
  tranche_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'create_terms', 'lock_funds', 'submit_result', 'request_refund',
    'authorize_withdrawal', 'authorize_refund'
  )),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL CHECK (attempts >= 0),
  last_error TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  lease_owner TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX contract_operations_by_status ON contract_operations (status, created_at);
CREATE INDEX contract_operations_by_contract ON contract_operations (contract_id, created_at);

-- Evidence files, stored once by SHA-256. Production moves them to object storage.
CREATE TABLE contract_evidence_content (
  sha256 TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  content BLOB NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0)
);

CREATE TABLE contract_evidence (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contract_contracts (id),
  milestone_id TEXT NOT NULL,
  sha256 TEXT NOT NULL REFERENCES contract_evidence_content (sha256),
  json TEXT NOT NULL CHECK (json_valid(json))
);

CREATE INDEX contract_evidence_by_milestone ON contract_evidence (contract_id, milestone_id);

-- Signed party actions already processed. A replay returns the earlier result.
CREATE TABLE contract_actions (
  action_id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contract_contracts (id),
  party_id TEXT NOT NULL,
  bytes_sha256 TEXT NOT NULL,
  processed_at INTEGER NOT NULL
);

-- Outbox of reliability updates. The service publishes each row once.
CREATE TABLE contract_publications (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contract_contracts (id),
  milestone_id TEXT NOT NULL,
  json TEXT NOT NULL CHECK (json_valid(json)),
  created_at INTEGER NOT NULL,
  published_at INTEGER
);

CREATE INDEX contract_publications_pending ON contract_publications (published_at, created_at);

-- Paper escrow model (no chain). Separate from the live rail.
CREATE TABLE contract_paper_escrows (
  ref TEXT PRIMARY KEY,
  json TEXT NOT NULL CHECK (json_valid(json))
);

CREATE TABLE contract_paper_escrow_ops (
  idempotency_key TEXT PRIMARY KEY,
  ref TEXT NOT NULL REFERENCES contract_paper_escrows (ref),
  kind TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- Paper mode clock: system time plus this offset. The offset only grows, so paper
-- time never goes back. Demos fast-forward by raising it.
CREATE TABLE contract_paper_clock (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  offset_ms INTEGER NOT NULL CHECK (offset_ms >= 0)
);
