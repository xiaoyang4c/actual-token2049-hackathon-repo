-- Lane A mock KYC onboarding: profiles and status history.
-- The lifecycle tables are in 011_lane_a_lifecycle.sql.

CREATE TABLE reliability_kyc_profiles (
  entity_id TEXT PRIMARY KEY REFERENCES reliability_entities (id),
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('person', 'business')),
  document_id TEXT,
  registration_number TEXT,
  beneficial_owner_document_id TEXT,
  checks_json TEXT NOT NULL CHECK (json_valid(checks_json)),
  re_registration_of TEXT REFERENCES reliability_entities (id),
  re_registration_signal TEXT CHECK (
    re_registration_signal IS NULL OR
    re_registration_signal IN ('document', 'registration_number')
  ),
  re_registration_value TEXT,
  rules_version TEXT NOT NULL,
  verified_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (re_registration_of IS NULL OR re_registration_of != entity_id),
  CHECK (
    (
      re_registration_of IS NULL AND
      re_registration_signal IS NULL AND
      re_registration_value IS NULL
    ) OR (
      re_registration_of IS NOT NULL AND
      re_registration_signal IS NOT NULL AND
      re_registration_value IS NOT NULL
    )
  )
);

CREATE INDEX reliability_kyc_profiles_by_document
  ON reliability_kyc_profiles (document_id);

CREATE INDEX reliability_kyc_profiles_by_registration
  ON reliability_kyc_profiles (registration_number);

CREATE INDEX reliability_kyc_profiles_by_beneficial_owner
  ON reliability_kyc_profiles (beneficial_owner_document_id);

CREATE TABLE reliability_kyc_status_records (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL REFERENCES reliability_entities (id),
  status TEXT NOT NULL CHECK (
    status IN ('unverified', 'pending', 'verified', 'rejected')
  ),
  tier TEXT NOT NULL CHECK (tier IN ('none', 'basic', 'enhanced')),
  badge TEXT NOT NULL CHECK (
    badge IN ('unverified', 'pending', 'verified', 'rejected', 'expired')
  ),
  how TEXT NOT NULL CHECK (
    how IN (
      'registered', 'check_submitted', 'vendor_approved', 'tier_raised',
      'vendor_rejected', 'vendor_hold', 'checks_short_of_tier', 'expired'
    )
  ),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  provider TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE INDEX reliability_kyc_status_records_by_entity
  ON reliability_kyc_status_records (entity_id, at, id);
