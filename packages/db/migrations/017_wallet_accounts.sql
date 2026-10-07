-- Wallet accounts: proof that a person controls a Cardano wallet, sign-in
-- sessions, and live preprod deposits into the Tally deposit address.
-- Read docs/wallets.md.

-- One sign-in message for one address. A challenge is used at most once.
CREATE TABLE reliability_wallet_challenges (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);

CREATE INDEX reliability_wallet_challenges_by_expiry
  ON reliability_wallet_challenges (expires_at);

-- A signed challenge proves control of one key. A stake key proof covers
-- every address of that wallet. A payment key proof covers one address.
CREATE TABLE reliability_wallet_proofs (
  address TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('stake', 'payment')),
  -- Blake2b-224 hash of the public key, as 56 hex characters.
  credential_hash TEXT NOT NULL UNIQUE,
  public_key_hex TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('cip30', 'browser')),
  wallet_name TEXT,
  challenge_id TEXT NOT NULL REFERENCES reliability_wallet_challenges (id),
  verified_at TEXT NOT NULL
);

CREATE INDEX reliability_wallet_proofs_by_entity
  ON reliability_wallet_proofs (entity_id);

-- Only the SHA-256 of a session token is stored.
CREATE TABLE reliability_sessions (
  token_hash TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Each asset in each output that pays the deposit address. A row without an
-- entity is unattributed: an operator must review it.
CREATE TABLE reliability_live_deposits (
  tx_hash TEXT NOT NULL,
  output_index INTEGER NOT NULL CHECK (output_index >= 0),
  -- 'lovelace' or policy id + asset name in hex.
  unit TEXT NOT NULL,
  quantity TEXT NOT NULL CHECK (quantity GLOB '[0-9]*' AND quantity != ''),
  deposit_address TEXT NOT NULL,
  entity_id TEXT REFERENCES reliability_entities (id),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'unattributed', 'rolled_back')),
  block_height INTEGER,
  block_time INTEGER,
  first_seen_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  note TEXT,
  PRIMARY KEY (tx_hash, output_index, unit)
);

CREATE INDEX reliability_live_deposits_by_entity
  ON reliability_live_deposits (entity_id, status);

-- Deposits that a signed-in user sent from the Tally website. The watcher
-- credits them only after it reads them from the chain.
CREATE TABLE reliability_deposit_submissions (
  tx_hash TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  from_address TEXT NOT NULL,
  amounts_json TEXT NOT NULL CHECK (json_valid(amounts_json)),
  submitted_at INTEGER NOT NULL
);
