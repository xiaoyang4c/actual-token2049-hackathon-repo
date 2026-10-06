-- Transaction reliability marketplace tables. The math lane owns scoring
-- and fee behavior, lane A owns the transaction lifecycle, escrow state
-- machine, and mock KYC, lane D owns payment evidence and fixtures.
-- Reserved follow-up numbers: 007 math lane, 008 lane A, 009 lane D.
-- New lanes take the next free number in that order. The trading
-- runtime tables above stay unchanged.

CREATE TABLE reliability_entities (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  roles_json TEXT NOT NULL CHECK (json_valid(roles_json)),
  kyc_status TEXT NOT NULL CHECK (
    kyc_status IN ('unverified', 'pending', 'verified', 'rejected')
  ),
  kyc_tier TEXT NOT NULL CHECK (
    kyc_tier IN ('none', 'basic', 'enhanced')
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE reliability_wallets (
  wallet TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  added_at TEXT NOT NULL
);

CREATE INDEX reliability_wallets_by_entity
  ON reliability_wallets (entity_id);

CREATE TABLE reliability_transactions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('goods', 'service', 'invoice')),
  buyer_id TEXT NOT NULL REFERENCES reliability_entities (id),
  seller_id TEXT NOT NULL REFERENCES reliability_entities (id),
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  terms_hash TEXT,
  value REAL,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX reliability_transactions_by_buyer
  ON reliability_transactions (buyer_id);

CREATE INDEX reliability_transactions_by_seller
  ON reliability_transactions (seller_id);

CREATE TABLE reliability_terms_versions (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions (id),
  version INTEGER NOT NULL CHECK (version >= 1),
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (transaction_id, version)
);

CREATE TABLE reliability_outcomes (
  transaction_id TEXT PRIMARY KEY REFERENCES reliability_transactions (id),
  state TEXT NOT NULL CHECK (
    state IN (
      'pending', 'successful', 'failed', 'disputed', 'cancelled', 'unresolved'
    )
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  verification_method TEXT NOT NULL CHECK (
    verification_method IN (
      'lifecycle', 'payment-settlement', 'manual-review', 'unverified'
    )
  ),
  verification_confidence REAL CHECK (
    verification_confidence IS NULL OR
    verification_confidence BETWEEN 0 AND 1
  ),
  resolver TEXT,
  resolve_by TEXT,
  decided_at TEXT NOT NULL
);

CREATE TABLE reliability_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions (id),
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  category TEXT NOT NULL CHECK (
    category IN (
      'compute', 'payment', 'fulfillment', 'delivery', 'sla', 'dispute'
    )
  ),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  verification_method TEXT NOT NULL,
  verification_confidence REAL,
  value REAL,
  created_at TEXT NOT NULL
);

CREATE INDEX reliability_events_by_entity
  ON reliability_events (entity_id, category, role);

CREATE INDEX reliability_events_by_transaction
  ON reliability_events (transaction_id);

CREATE TABLE reliability_state (
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  category TEXT NOT NULL CHECK (
    category IN (
      'compute', 'payment', 'fulfillment', 'delivery', 'sla', 'dispute'
    )
  ),
  role TEXT NOT NULL CHECK (role IN ('buyer', 'seller')),
  alpha REAL NOT NULL CHECK (alpha > 0),
  beta REAL NOT NULL CHECK (beta > 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_id, category, role)
);

CREATE TABLE reliability_terms_decisions (
  id INTEGER PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  category TEXT NOT NULL,
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  terms_json TEXT NOT NULL CHECK (json_valid(terms_json)),
  buyer_fee_bps INTEGER NOT NULL CHECK (buyer_fee_bps >= 0),
  seller_fee_bps INTEGER NOT NULL CHECK (seller_fee_bps >= 0),
  reason_code TEXT NOT NULL CHECK (
    reason_code IN (
      'NEW_ENTITY', 'LOW_CONFIDENCE', 'STRONG_HISTORY', 'WEAK_HISTORY',
      'REPEAT_PAIR_DISCOUNT', 'KYC_LIMIT', 'POLICY_DEFAULT'
    )
  ),
  policy_version TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

CREATE INDEX reliability_terms_decisions_by_entity
  ON reliability_terms_decisions (entity_id, category, id);
