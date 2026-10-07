-- Math lane (reserved number 007): recorded event weights and repeat-pair
-- membership. A weight row stores every input of W = a * w * D(n), so reads
-- and rebuilds reuse it. A pair row marks one eligible transaction for a
-- buyer, seller, and category key. Its position is the count of earlier
-- eligible transactions for that key.

CREATE TABLE reliability_event_weights (
  event_id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions (id),
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  category TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
  inputs_key TEXT NOT NULL,
  eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
  normalized_value REAL,
  value_scale REAL NOT NULL CHECK (value_scale > 0),
  value_weight REAL NOT NULL CHECK (value_weight >= 0),
  pair_key TEXT,
  pair_count INTEGER NOT NULL CHECK (pair_count >= 0),
  pair_factor REAL NOT NULL CHECK (pair_factor > 0 AND pair_factor <= 1),
  weight REAL NOT NULL CHECK (weight >= 0),
  reason TEXT NOT NULL,
  scoring_version TEXT NOT NULL,
  decay_version TEXT NOT NULL,
  computed_at TEXT NOT NULL
);

CREATE INDEX reliability_event_weights_by_transaction
  ON reliability_event_weights (transaction_id);

CREATE TABLE reliability_pair_transactions (
  pair_key TEXT NOT NULL,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions (id),
  position INTEGER NOT NULL CHECK (position >= 0),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (pair_key, transaction_id)
);

CREATE INDEX reliability_pair_transactions_by_transaction
  ON reliability_pair_transactions (transaction_id);
