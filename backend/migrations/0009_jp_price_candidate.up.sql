-- Contract price review queue.
--
-- One row per (job, proposal) the price scan has examined: what the document
-- was classified as, what amount was extracted, and what a human decided. The
-- automation NEVER writes a price to JobProgress from the scan itself — a row
-- must be approved by an admin, and the apply step re-checks the live
-- financials so an existing price is never overwritten.
--
-- The unique constraint is what makes rescanning safe: a proposal that has
-- already been examined (whatever its outcome) is never proposed twice.

CREATE TABLE jp_price_candidate (
  id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_job_id            text NOT NULL,
  job_number           text,
  job_name             text,
  customer_id          text,
  contract_signed_date date,
  proposal_id          text NOT NULL,
  proposal_title       text,
  proposal_file_name   text,
  proposal_status      text,
  -- What the document turned out to be. Only retail_contract rows become
  -- actionable; the rest are kept as an audit of what was looked at and why
  -- it was not proposed.
  classification       text,
  extracted_amount     numeric(12,2),
  extracted_job_number text,
  confidence           text,
  extraction_notes     text,
  model                text,
  status               text NOT NULL DEFAULT 'pending',
  reviewed_by          text,
  reviewed_at          timestamptz,
  applied_at           timestamptz,
  apply_error          text,
  raw                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_price_candidate_uniq UNIQUE (jp_job_id, proposal_id),
  CONSTRAINT jp_price_candidate_status_valid
    CHECK (status IN ('pending','applied','rejected','failed','skipped')),
  CONSTRAINT jp_price_candidate_classification_valid
    CHECK (classification IS NULL OR classification IN
      ('retail_contract','change_order','insurance','other','unreadable'))
);

CREATE INDEX jp_price_candidate_pending_idx ON jp_price_candidate (created_at DESC)
  WHERE status = 'pending';
CREATE INDEX jp_price_candidate_job_idx ON jp_price_candidate (jp_job_id);

CREATE TRIGGER jp_price_candidate_updated_at BEFORE UPDATE ON jp_price_candidate
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

-- Reads are admin-only (this is a money workflow); every write goes through
-- the jobs pool via the scan/approve endpoints — the app role cannot touch it.
GRANT SELECT ON jp_price_candidate TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_price_candidate TO allied_jobs;

ALTER TABLE jp_price_candidate ENABLE ROW LEVEL SECURITY;

CREATE POLICY jp_price_candidate_select ON jp_price_candidate FOR SELECT
  USING (allied_is_admin());
