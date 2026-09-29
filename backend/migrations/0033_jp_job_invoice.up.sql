-- Job invoices: the PM's Invoiced AR (Revenue & AR page).
--
-- GET /jobs/{id}/invoices?status=all lists every invoice the office raised on
-- the job: number, date, due date, total, open balance, open/closed. Verified
-- live 2026-09-29 (Guinto: 667-1823 dated 9/2 for $20,599 and the change
-- order 667-1832 dated 9/15 for $3,600, both closed). The invoice date should
-- match the job's start when the process is followed, so the page filters
-- Invoiced AR by it and names started jobs with no invoice.
--
-- Mirrored per tracked job on a timer, like vendor bills. An invoice
-- JobProgress no longer returns is retired (deleted_at), never erased.

CREATE TABLE jp_job_invoice (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_invoice_id   text NOT NULL,
  jp_job_id       text NOT NULL,
  invoice_number  text,
  title           text,
  invoice_date    date,
  due_date        date,
  total_amount    numeric(12,2) NOT NULL DEFAULT 0,
  open_balance    numeric(12,2),
  status          text,
  invoice_type    text,
  raw             jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_job_invoice_id_uniq UNIQUE (jp_invoice_id)
);
CREATE INDEX jp_job_invoice_job_idx ON jp_job_invoice (jp_job_id) WHERE deleted_at IS NULL;
CREATE TRIGGER jp_job_invoice_updated_at BEFORE UPDATE ON jp_job_invoice
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

ALTER TABLE jp_job ADD COLUMN invoices_fetched_at timestamptz;

GRANT SELECT ON jp_job_invoice TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_job_invoice TO allied_jobs;
ALTER TABLE jp_job_invoice ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_job_invoice_select ON jp_job_invoice FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
