-- Financial settlement is separate from response delivery. Old local receipt
-- states do not prove that money reached a buyer or seller.
CREATE TABLE payment_settlements (
  receipt_id TEXT PRIMARY KEY REFERENCES payment_receipts (receipt_id),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'funds_locked', 'result_queued', 'result_confirmed',
    'withdrawal_pending', 'withdrawal_available', 'withdrawn', 'disputed',
    'refund_requested', 'refund_authorized', 'refund_available', 'refund_pending',
    'refunded', 'disputed_settled', 'expired_unfunded', 'recovery_required', 'unknown'
  )),
  last_verified_status TEXT CHECK (last_verified_status IN (
    'pending', 'funds_locked', 'result_queued', 'result_confirmed',
    'withdrawal_pending', 'withdrawal_available', 'withdrawn', 'disputed',
    'refund_requested', 'refund_authorized', 'refund_available', 'refund_pending',
    'refunded', 'disputed_settled', 'expired_unfunded', 'recovery_required', 'unknown'
  )),
  last_verified_at TEXT,
  next_check_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_checked_at TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX payment_settlements_due
  ON payment_settlements (next_check_at, receipt_id)
  WHERE next_check_at IS NOT NULL;

CREATE TABLE payment_settlement_observations (
  id INTEGER PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES payment_settlements (receipt_id),
  observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'funds_locked', 'result_queued', 'result_confirmed',
    'withdrawal_pending', 'withdrawal_available', 'withdrawn', 'disputed',
    'refund_requested', 'refund_authorized', 'refund_available', 'refund_pending',
    'refunded', 'disputed_settled', 'expired_unfunded', 'recovery_required', 'unknown'
  )),
  verified INTEGER NOT NULL CHECK (verified IN (0, 1)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  error TEXT,
  next_check_at TEXT
);

CREATE INDEX payment_settlement_observations_by_receipt
  ON payment_settlement_observations (receipt_id, id);

-- Verified proof remains directly accessible even after many failed checks.
CREATE INDEX payment_settlement_verified_observations_by_receipt
  ON payment_settlement_observations (receipt_id, id)
  WHERE verified = 1;

CREATE TRIGGER payment_settlement_observations_no_update
BEFORE UPDATE ON payment_settlement_observations
BEGIN
  SELECT RAISE(ABORT, 'settlement observations are append-only');
END;

CREATE TRIGGER payment_settlement_observations_no_delete
BEFORE DELETE ON payment_settlement_observations
BEGIN
  SELECT RAISE(ABORT, 'settlement observations are append-only');
END;

-- Only protocol receipts need reconciliation. Start from pending even when a
-- legacy receipt says released or refunded. The worker must verify settlement.
INSERT INTO payment_settlements (receipt_id, status, next_check_at, updated_at)
SELECT receipt_id, 'pending',
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  COALESCE(strftime('%Y-%m-%dT%H:%M:%fZ', updated_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', created_at),
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
FROM payment_receipts
WHERE protocol_data IS NOT NULL;
