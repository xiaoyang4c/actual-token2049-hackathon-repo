-- Paper accounting only. These tables do not establish chain custody.
CREATE TABLE reliability_omnibus_pools (
  pool_id TEXT PRIMARY KEY,
  pool_address TEXT NOT NULL UNIQUE CHECK (pool_address LIKE 'paper:pool:%')
);

CREATE TABLE reliability_omnibus_deposits (
  idempotency_key TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES reliability_omnibus_pools (pool_id),
  business_id TEXT NOT NULL REFERENCES reliability_entities (id),
  source_address TEXT NOT NULL CHECK (source_address LIKE 'paper:business:%'),
  deposit_tx_hash TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  amount_lovelace INTEGER NOT NULL CHECK (
    amount_lovelace > 0 AND amount_lovelace <= 9007199254740991
  ),
  at TEXT NOT NULL,
  UNIQUE (deposit_tx_hash, output_index)
);

CREATE INDEX reliability_omnibus_deposits_by_business
  ON reliability_omnibus_deposits (pool_id, business_id);

CREATE TABLE reliability_omnibus_deal_funding (
  idempotency_key TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES reliability_omnibus_pools (pool_id),
  business_id TEXT NOT NULL REFERENCES reliability_entities (id),
  transaction_id TEXT NOT NULL UNIQUE REFERENCES reliability_transactions (id),
  deal_address TEXT NOT NULL UNIQUE CHECK (deal_address LIKE 'paper:deal:%'),
  tx_hash TEXT NOT NULL UNIQUE CHECK (tx_hash LIKE 'paper:%'),
  amount_lovelace INTEGER NOT NULL CHECK (
    amount_lovelace > 0 AND amount_lovelace <= 9007199254740991
  ),
  at TEXT NOT NULL
);

CREATE INDEX reliability_omnibus_funding_by_business
  ON reliability_omnibus_deal_funding (pool_id, business_id);
