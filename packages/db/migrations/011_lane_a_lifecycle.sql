-- Lane A transaction lifecycle history.
-- File name: 011_lane_a_lifecycle.sql.
-- KYC already uses migration 008. Lane D keeps 009.
-- Do not reuse version 011 for another file. 010 stores Outcome.fault.

CREATE TABLE reliability_lifecycle_transitions (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES reliability_transactions (id),
  from_stage TEXT CHECK (
    from_stage IS NULL OR from_stage IN (
      'offer_accepted', 'escrow_funded', 'delivery_confirmed',
      'payment_settled', 'dispute_opened', 'dispute_resolved',
      'refunded', 'cancelled'
    )
  ),
  to_stage TEXT NOT NULL CHECK (
    to_stage IN (
      'offer_accepted', 'escrow_funded', 'delivery_confirmed',
      'payment_settled', 'dispute_opened', 'dispute_resolved',
      'refunded', 'cancelled'
    )
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  at TEXT NOT NULL
);

CREATE INDEX reliability_lifecycle_by_transaction
  ON reliability_lifecycle_transitions (transaction_id, id);
