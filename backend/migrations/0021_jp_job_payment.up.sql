-- Job payments: the Weekly Job Sheet's Payment Method, Deposit and Progress
-- Payment columns.
--
-- GET /jobs/{id}/financial_summary (0007, 0020) gives payment TOTALS only.
-- GET /jobs/{id}/payment_history lists each payment the office recorded on
-- the job: amount, method, date, status. The sheet's Deposit is the first of
-- them, Progress Payments the rest, Payment Method the methods used.
--
-- Mirrored per job, one call per job, only when the job's payment total has
-- changed since the last read (payments_fetched_total) — so a job that has
-- not been paid since is never re-read. A payment JobProgress no longer
-- returns is retired (deleted_at), never erased.

CREATE TABLE jp_job_payment (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_payment_id    text NOT NULL,
  jp_job_id        text NOT NULL,
  jp_customer_id   text,
  amount           numeric(12,2) NOT NULL,
  -- The API's method code ("cash", "echeque", "cc"…) and the office's label
  -- for it from /company/payment_types ("Cash", "Check", "Credit Card"…).
  method           text,
  method_label     text,
  payment_date     date,
  status           text,
  canceled         boolean NOT NULL DEFAULT false,
  reference_number text,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_job_payment_id_uniq UNIQUE (jp_payment_id)
);
CREATE INDEX jp_job_payment_job_idx ON jp_job_payment (jp_job_id) WHERE deleted_at IS NULL;
CREATE TRIGGER jp_job_payment_updated_at BEFORE UPDATE ON jp_job_payment
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

ALTER TABLE jp_job ADD COLUMN payments_fetched_at    timestamptz;
ALTER TABLE jp_job ADD COLUMN payments_fetched_total numeric(12,2);
COMMENT ON COLUMN jp_job.payments_fetched_total IS
  'total_payment_received at the time the payment list was last read; a different total now means the list is re-read.';

GRANT SELECT ON jp_job_payment TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_job_payment TO allied_jobs;
ALTER TABLE jp_job_payment ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_job_payment_select ON jp_job_payment FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
