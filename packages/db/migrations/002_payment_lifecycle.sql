-- Keep old receipts. New payments use explicit local lifecycle states.
CREATE TABLE payment_receipts_next (
  receipt_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payer TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  network TEXT NOT NULL,
  amount INTEGER NOT NULL,
  asset TEXT NOT NULL,
  pay_to TEXT NOT NULL,
  resource TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'submitted', 'confirmed', 'delivered', 'refund_requested',
    'escrowed', 'released', 'refunded'
  )),
  simulated INTEGER NOT NULL CHECK (simulated IN (0, 1)),
  cycle_id TEXT REFERENCES runs (id),
  order_key TEXT REFERENCES orders (idempotency_key),
  created_at TEXT NOT NULL,
  input_hash TEXT,
  protocol_data TEXT,
  response_json TEXT,
  result_hash TEXT,
  confirmed_at TEXT,
  delivered_at TEXT,
  updated_at TEXT
);

INSERT INTO payment_receipts_next (
  receipt_id, idempotency_key, payer, tx_hash, network, amount, asset,
  pay_to, resource, status, simulated, cycle_id, order_key, created_at
)
SELECT receipt_id, idempotency_key, payer, tx_hash, network, amount, asset,
  pay_to, resource, status, simulated, cycle_id, order_key, created_at
FROM payment_receipts;

DROP TABLE payment_receipts;
ALTER TABLE payment_receipts_next RENAME TO payment_receipts;
CREATE INDEX payment_receipts_by_cycle ON payment_receipts (cycle_id);
CREATE INDEX payment_receipts_by_order ON payment_receipts (order_key);
