-- Vendor bills: what the job actually cost, from JobProgress.
--
-- GET /jobs/{id}/vendor_bills lists every supplier, sub-contractor and
-- carting invoice the office entered on the job (QuickBooks-synced vendors).
-- Verified live 2026-09-10: 25 of 60 production jobs carried bills, from
-- New Castle Building Products, QXO, Lansing, Home Depot (material), Bin Drop
-- Waste Services (carting), Cavallari, Lucy, DNC, AK, AMK (labor).
--
-- The Weekly Job Sheet reads them for Material Vendor (AD), Container
-- Scheduled (AI) and the Actual Material / Labor / Carting / Other COGS
-- columns (BH..BL) that the master sheet pulls from its AP ledger tab.
-- Category is a keyword classification of the vendor name
-- (shared/src/weeklyJobSheet.js classifyVendor), recomputed on every read.

CREATE TABLE jp_vendor_bill (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_bill_id    text NOT NULL,
  jp_job_id     text NOT NULL,
  vendor_id     text,
  vendor_name   text,
  vendor_origin text,
  category      text NOT NULL DEFAULT 'other',
  bill_number   text,
  bill_date     date,
  due_date      date,
  note          text,
  total_amount  numeric(12,2) NOT NULL DEFAULT 0,
  tax_amount    numeric(12,2),
  origin        text,
  raw           jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_vendor_bill_id_uniq UNIQUE (jp_bill_id),
  CONSTRAINT jp_vendor_bill_category_valid CHECK (category IN ('material', 'labor', 'carting', 'other'))
);
CREATE INDEX jp_vendor_bill_job_idx ON jp_vendor_bill (jp_job_id) WHERE deleted_at IS NULL;
CREATE TRIGGER jp_vendor_bill_updated_at BEFORE UPDATE ON jp_vendor_bill
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

-- Bills have no "changed since" signal on the job, so each tracked job's list
-- is re-read on a timer (daily) rather than on a trigger.
ALTER TABLE jp_job ADD COLUMN bills_fetched_at timestamptz;

GRANT SELECT ON jp_vendor_bill TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_vendor_bill TO allied_jobs;
ALTER TABLE jp_vendor_bill ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_vendor_bill_select ON jp_vendor_bill FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
