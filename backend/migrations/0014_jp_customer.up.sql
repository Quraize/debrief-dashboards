-- CRM marketing attribution: customers (leads) and the referral-source list.
--
-- JobProgress records the lead source on every CUSTOMER at intake
-- (referred_by → one of the office's referral sources, or "referred by an
-- existing customer", or a free-text note). Jobs and appointments inherit it
-- through the customer. The marketing dashboard's CRM section reads these
-- mirrors: leads by source and month, and appointments/demos/sales by source
-- via the customer id — the debrief form's dropdown is the same list.
--
-- No phone numbers or emails are mirrored: the dashboards need the lead date,
-- the source and the town, nothing else.

ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers'));

CREATE TABLE jp_referral (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_referral_id text NOT NULL,
  name           text NOT NULL,
  jp_created_at  timestamptz,
  jp_updated_at  timestamptz,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_referral_id_uniq UNIQUE (jp_referral_id)
);
CREATE TRIGGER jp_referral_updated_at BEFORE UPDATE ON jp_referral
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

CREATE TABLE jp_customer (
  id                      text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_customer_id          text NOT NULL,
  customer_name           text,
  company_name            text,
  is_commercial           boolean NOT NULL DEFAULT false,
  -- 'referral' (a source from jp_referral), 'customer' (an existing customer
  -- referred them), or blank.
  referred_by_type        text,
  referred_by_id          text,
  referred_by_name        text,
  referred_by_note        text,
  referred_by_customer_id text,
  call_center_rep         text,
  canvasser               text,
  city                    text,
  state                   text,
  zip                     text,
  -- The lead date: when the customer was created in the CRM.
  jp_created_at           timestamptz,
  jp_updated_at           timestamptz,
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  raw                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_customer_id_uniq UNIQUE (jp_customer_id)
);
CREATE INDEX jp_customer_created_idx ON jp_customer (jp_created_at);
CREATE INDEX jp_customer_source_idx ON jp_customer (referred_by_name);
CREATE TRIGGER jp_customer_updated_at BEFORE UPDATE ON jp_customer
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

-- The join key from appointments and jobs to their customer. The API payload
-- has always carried it; it was just never typed out. Backfilled from raw so
-- no re-sync is needed.
ALTER TABLE jp_appointment ADD COLUMN jp_customer_id text;
UPDATE jp_appointment SET jp_customer_id = raw->>'customer_id'
  WHERE raw ? 'customer_id' AND raw->>'customer_id' <> '';
CREATE INDEX jp_appointment_customer_idx ON jp_appointment (jp_customer_id);

ALTER TABLE jp_job ADD COLUMN jp_customer_id text;
UPDATE jp_job SET jp_customer_id = raw->>'customer_id'
  WHERE raw ? 'customer_id' AND raw->>'customer_id' <> '';
CREATE INDEX jp_job_customer_idx ON jp_job (jp_customer_id);

GRANT SELECT ON jp_referral, jp_customer TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_referral, jp_customer TO allied_jobs;

ALTER TABLE jp_referral ENABLE ROW LEVEL SECURITY;
ALTER TABLE jp_customer ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_referral_select ON jp_referral FOR SELECT USING (allied_is_authenticated());
CREATE POLICY jp_customer_select ON jp_customer FOR SELECT USING (allied_is_authenticated());
