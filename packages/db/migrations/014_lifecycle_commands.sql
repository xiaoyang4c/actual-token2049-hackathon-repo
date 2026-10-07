-- Durable command results and external-call checkpoints for marketplace escrow.
CREATE TABLE reliability_lifecycle_commands (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions(id),
  action TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK(json_valid(input_json)),
  effects_json TEXT NOT NULL CHECK(json_valid(effects_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  status TEXT NOT NULL CHECK(status IN ('pending', 'completed'))
);
CREATE UNIQUE INDEX reliability_one_pending_command
  ON reliability_lifecycle_commands(transaction_id) WHERE status = 'pending';
CREATE TABLE reliability_event_revisions (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions(id),
  events_json TEXT NOT NULL CHECK(json_valid(events_json)),
  revised_at TEXT NOT NULL
);
CREATE TABLE reliability_score_baselines (
  entity_id TEXT NOT NULL REFERENCES reliability_entities(id),
  category TEXT NOT NULL,
  role TEXT NOT NULL,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  PRIMARY KEY(entity_id, category, role)
);
CREATE TABLE reliability_listings (
  id TEXT PRIMARY KEY,
  listing_json TEXT NOT NULL CHECK(json_valid(listing_json))
);
