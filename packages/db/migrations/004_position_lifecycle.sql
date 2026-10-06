ALTER TABLE agent_state ADD COLUMN trading_day TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_state ADD COLUMN realized_pnl REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_state ADD COLUMN daily_realized_pnl REAL NOT NULL DEFAULT 0;
ALTER TABLE agent_state ADD COLUMN pnl_adjustment REAL NOT NULL DEFAULT 0;

-- Preserve the entry-marked book and any existing demo P&L shock.
UPDATE agent_state SET
  trading_day = substr(updated_at, 1, 10),
  pnl_adjustment = equity - cash - COALESCE((
    SELECT SUM(json_extract(value, '$.size') * json_extract(value, '$.avgPrice'))
    FROM json_each(agent_state.positions_json)
  ), 0);

CREATE TABLE market_quotes (
  venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
  market_id TEXT NOT NULL,
  yes_price REAL NOT NULL CHECK (yes_price BETWEEN 0 AND 1),
  best_bid REAL NOT NULL CHECK (best_bid BETWEEN 0 AND 1),
  best_ask REAL NOT NULL CHECK (best_ask BETWEEN best_bid AND 1),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (venue, market_id)
);

CREATE TABLE position_events (
  idempotency_key TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('close', 'resolve')),
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE market_resolutions (
  venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
  market_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('yes', 'no', 'void')),
  resolved_at TEXT NOT NULL,
  event_key TEXT NOT NULL REFERENCES position_events (idempotency_key),
  PRIMARY KEY (venue, market_id)
);

CREATE TABLE daily_summaries (
  trading_day TEXT PRIMARY KEY,
  start_equity REAL NOT NULL,
  end_equity REAL NOT NULL,
  pnl REAL NOT NULL,
  realized_pnl REAL NOT NULL,
  recorded_at TEXT NOT NULL
);
