-- Settlement anchors. Each final milestone record (a contract publication
-- whose outcome is final) gets a fingerprint, chained per company, and the
-- fingerprints are posted to Cardano in a batch transaction.
--
-- Entries are append-only. A batch is confirmed only after its metadata is
-- read back from the chain, and expires only after its validity interval
-- has passed with no transaction on the chain.

CREATE TABLE reliability_anchor_batches (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('prepared', 'submitted', 'confirmed', 'expired')),
  tx_hash TEXT NOT NULL UNIQUE,
  tx_cbor TEXT NOT NULL,
  -- The last slot in which the transaction is valid.
  invalid_hereafter INTEGER NOT NULL,
  entry_hashes_json TEXT NOT NULL CHECK (json_valid(entry_hashes_json)),
  created_at INTEGER NOT NULL,
  submitted_at INTEGER,
  confirmed_at INTEGER,
  block_height INTEGER,
  block_time INTEGER,
  note TEXT
);

-- At most one batch is prepared or submitted at a time, so batches never spend the same inputs.
CREATE UNIQUE INDEX reliability_one_open_anchor_batch
  ON reliability_anchor_batches ((status IN ('prepared', 'submitted'))) WHERE status IN ('prepared', 'submitted');

CREATE TABLE reliability_anchor_entries (
  entry_hash TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  prev_hash TEXT NOT NULL,
  record_hash TEXT NOT NULL,
  publication_id TEXT NOT NULL REFERENCES contract_publications (id),
  contract_id TEXT NOT NULL,
  milestone_id TEXT NOT NULL,
  -- The batch that carries this entry now. Cleared when that batch expires.
  batch_id TEXT REFERENCES reliability_anchor_batches (id),
  created_at INTEGER NOT NULL,
  UNIQUE (entity_id, seq),
  UNIQUE (publication_id, entity_id)
);

CREATE INDEX reliability_anchor_entries_batch ON reliability_anchor_entries (batch_id, created_at);
CREATE INDEX reliability_anchor_entries_contract ON reliability_anchor_entries (contract_id);
