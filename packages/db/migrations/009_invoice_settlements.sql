-- Lane D (reserved number 009): one payment observation for each invoice.
-- The reference is unique, so one payment cannot settle two invoices.
-- `verified` is 1 only for confirmed chain proof. Paper rows stay 0.

CREATE TABLE reliability_invoice_settlements (
  transaction_id TEXT PRIMARY KEY REFERENCES reliability_transactions (id),
  reference TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  settled_at TEXT NOT NULL,
  amount_minor TEXT NOT NULL,
  currency TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
