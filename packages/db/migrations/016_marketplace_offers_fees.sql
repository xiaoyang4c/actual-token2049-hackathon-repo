-- Marketplace writes and accepted fee charges. Number 015 is reserved for
-- the settlement anchor branch (lane-a/coworker-worker).
--
-- An offer row holds one buyer offer on a listing. Its status moves from
-- open to accepted, declined, withdrawn, or expired once. A fee charge row
-- holds the accepted buyer and seller platform fees for one sale. Its
-- status moves from accepted to collected or waived. A collected charge
-- moves to refunded when a correction fails or cancels the sale. Contract
-- milestone sales get a charge before their transaction row exists, so
-- the charge has no foreign key.

CREATE TABLE reliability_offers (
  id TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES reliability_listings (id),
  buyer_id TEXT NOT NULL REFERENCES reliability_entities (id),
  seller_id TEXT NOT NULL REFERENCES reliability_entities (id),
  status TEXT NOT NULL CHECK (
    status IN ('open', 'accepted', 'declined', 'withdrawn', 'expired')
  ),
  transaction_id TEXT UNIQUE,
  offer_json TEXT NOT NULL CHECK (json_valid(offer_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX reliability_offers_by_listing
  ON reliability_offers (listing_id, created_at);

CREATE TABLE reliability_fee_charges (
  transaction_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (
    status IN ('accepted', 'collected', 'waived', 'refunded')
  ),
  charge_json TEXT NOT NULL CHECK (json_valid(charge_json)),
  accepted_at TEXT NOT NULL,
  settled_at TEXT
);
