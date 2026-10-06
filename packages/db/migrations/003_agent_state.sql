-- The current paper book is separate from historical cycle snapshots.
-- Orders and this row must change in the same transaction.
CREATE TABLE agent_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy_id INTEGER NOT NULL REFERENCES policy (id),
  cash REAL NOT NULL,
  equity REAL NOT NULL,
  start_of_day_equity REAL NOT NULL,
  high_water_mark REAL NOT NULL,
  daily_pnl REAL NOT NULL,
  positions_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
