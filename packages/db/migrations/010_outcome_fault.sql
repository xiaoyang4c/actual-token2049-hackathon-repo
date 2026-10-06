-- Stores the at-fault role on a reliability outcome.
-- buyer and seller name the role that failed.
-- none and NULL change no reliability score.
-- A successful outcome leaves this column empty.

ALTER TABLE reliability_outcomes
  ADD COLUMN fault TEXT CHECK (
    fault IS NULL OR fault IN ('buyer', 'seller', 'none')
  );
