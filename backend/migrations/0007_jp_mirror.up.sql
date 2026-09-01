-- JobProgress mirror tables.
--
-- The `appointment` table is the operational matching table: sales-type rows
-- only, consumed by debrief matching and the Missing Debriefs metric. These two
-- tables are different in kind — a read-only mirror of what the CRM itself
-- recorded, powering the "From JobProgress" dashboard sections:
--
--  * jp_appointment — every appointment on the JP calendar, non-sales included
--    (flagged, not filtered), with the result form's parsed Two-Leg answer.
--    Without the non-sales rows the volume cards would repeat the debrief-side
--    blind spot this mirror exists to expose.
--
--  * jp_job — every JP job the sync has seen with a signed contract, carrying
--    the CRM's own financial summary. This is the reconciliation counterpart of
--    the rep-typed debrief sale_amount.
--
-- Both keep the raw API payload in a jsonb column so a field the mapper does
-- not yet type out survives the sync that saw it.

CREATE TABLE jp_appointment (
  id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- JobProgress's own appointment id: the natural key the sync upserts on.
  jp_appointment_id   text NOT NULL,
  title               text,
  appointment_date    date,
  appointment_time    text,
  customer_name       text,
  location            text,
  crm_lead_id         text,
  crm_job_id          text,
  -- The CRM's attribution: user = assigned rep, created_by = who booked it.
  sales_rep           text,
  appointment_setter  text,
  division            text,
  is_sales_type       boolean NOT NULL DEFAULT true,
  is_insurance        boolean NOT NULL DEFAULT false,
  -- Result form (parsed by @allied/shared/jpResult at sync time).
  has_result          boolean NOT NULL DEFAULT false,
  result_group        text,
  result_option_name  text,
  two_leg_answer      text,
  two_leg_raw         text,
  jp_created_at       timestamptz,
  jp_updated_at       timestamptz,
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_appointment_id_uniq UNIQUE (jp_appointment_id),
  CONSTRAINT jp_appointment_two_leg_valid
    CHECK (two_leg_answer IS NULL OR two_leg_answer IN ('two_leg','one_leg','other'))
);

CREATE TABLE jp_job (
  id                        text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_job_id                 text NOT NULL,
  job_number                text,
  job_name                  text,
  division                  text,
  trades                    text,
  is_insurance              boolean NOT NULL DEFAULT false,
  current_stage             text,
  contract_signed_date      date,
  jp_created_at             timestamptz,
  jp_updated_at             timestamptz,
  -- From GET /jobs/{id}/financial_summary. NULL means the summary was not
  -- fetched or the API refused it (it 412s on some jobs) — surfaced on the
  -- dashboards as "missing financials", never silently zero.
  total_job_revenue         numeric(12,2),
  total_job_price           numeric(12,2),
  total_change_order_amount numeric(12,2),
  financials_fetched_at     timestamptz,
  raw                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_job_id_uniq UNIQUE (jp_job_id)
);

CREATE INDEX jp_appointment_date_idx ON jp_appointment (appointment_date);
CREATE INDEX jp_appointment_lead_idx ON jp_appointment (crm_lead_id) WHERE crm_lead_id IS NOT NULL;
CREATE INDEX jp_job_signed_idx       ON jp_job (contract_signed_date) WHERE contract_signed_date IS NOT NULL;
CREATE INDEX jp_job_number_idx       ON jp_job (job_number) WHERE job_number IS NOT NULL;

CREATE TRIGGER jp_appointment_updated_at BEFORE UPDATE ON jp_appointment
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
CREATE TRIGGER jp_job_updated_at BEFORE UPDATE ON jp_job
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

-- Dashboards are visible to every signed-in role, so reads are open to the app
-- role; writes happen only through the jobs pool (allied_jobs, BYPASSRLS) —
-- the app role holds no INSERT/UPDATE/DELETE privilege at all.
GRANT SELECT ON jp_appointment, jp_job TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_appointment, jp_job TO allied_jobs;

ALTER TABLE jp_appointment ENABLE ROW LEVEL SECURITY;
ALTER TABLE jp_job         ENABLE ROW LEVEL SECURITY;

CREATE POLICY jp_appointment_select ON jp_appointment FOR SELECT
  USING (allied_is_authenticated());
CREATE POLICY jp_job_select ON jp_job FOR SELECT
  USING (allied_is_authenticated());
