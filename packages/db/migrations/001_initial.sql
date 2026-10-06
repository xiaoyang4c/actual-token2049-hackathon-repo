-- Agent runtime tables. Shaped from packages/core policy types and the
-- in-memory control API (policy, portfolio, orders/fills, audit entries).
-- payment_receipts stores a Cardano x402/Masumi receipt without calling
-- a chain: payer, amount, tx hash, receipt id, status, and an optional
-- link to a cycle (runs.id) or an order (orders.idempotency_key).

CREATE TABLE policy (
  id INTEGER PRIMARY KEY,
  max_bet REAL NOT NULL,
  max_daily_loss REAL NOT NULL,
  category_allow TEXT NOT NULL,
  category_deny TEXT NOT NULL,
  venues_enabled TEXT NOT NULL,
  stop_loss_pct REAL NOT NULL,
  kill_switch INTEGER NOT NULL CHECK (kill_switch IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  policy_id INTEGER REFERENCES policy (id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'completed', 'halted', 'failed')
  ),
  summary TEXT NOT NULL,
  cash REAL NOT NULL,
  equity REAL NOT NULL,
  start_of_day_equity REAL NOT NULL,
  high_water_mark REAL NOT NULL,
  daily_pnl REAL NOT NULL,
  positions_json TEXT NOT NULL
);

CREATE TABLE orders (
  idempotency_key TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES runs (id),
  venue TEXT NOT NULL CHECK (venue IN ('polymarket', 'kalshi')),
  market_id TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('yes', 'no')),
  size REAL NOT NULL,
  limit_price REAL NOT NULL,
  price REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('filled', 'rejected')),
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX orders_by_cycle ON orders (cycle_id);

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  cycle_id TEXT NOT NULL REFERENCES runs (id),
  received_at TEXT NOT NULL,
  "type" TEXT NOT NULL,
  detail TEXT NOT NULL
);

CREATE INDEX audit_events_by_cycle ON audit_events (cycle_id);

-- amount is the integer minor-unit value (lovelace), matching the
-- Cardano agent receipt. simulated is 0 for a later live receipt.
CREATE TABLE payment_receipts (
  receipt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  network TEXT NOT NULL,
  amount INTEGER NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('escrowed', 'released', 'refunded')
  ),
  simulated INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  cycle_id TEXT REFERENCES runs (id),
  order_key TEXT REFERENCES orders (idempotency_key),
  created_at TEXT NOT NULL
);

CREATE INDEX payment_receipts_by_cycle ON payment_receipts (cycle_id);

CREATE INDEX payment_receipts_by_order ON payment_receipts (order_key);
