-- Core schema, translated from base44/entities/*.jsonc.
--
-- Deliberate decisions, so they are not re-litigated later:
--
--  * `id` is TEXT, not UUID. Base44's identifiers must survive the import
--    verbatim so that debrief.appointment_id keeps pointing at the right row.
--    We do not yet know their exact format, and a UUID column would reject
--    anything that is not one. New rows default to a UUID rendered as text.
--
--  * Money is NUMERIC(12,2), never double precision. Floating point money
--    silently loses cents, and these figures drive commission.
--
--  * appointment_time stays TEXT. The source contains values like "09:30" but
--    also free text; coercing to TIME would discard rows rather than import them.
--    The identity key normalises it instead (see 0003).
--
--  * Closed value sets use CHECK constraints rather than PostgreSQL ENUM types.
--    Adding a value to an enum requires ALTER TYPE, which does not roll back
--    cleanly inside a transaction; a CHECK is a one-line, reversible migration.
--
--  * created_by defaults from the request's session context so the write-own
--    policy in 0004 has something to compare against. It is the user's email,
--    matching Base44's own created_by semantics.

-- ─────────────────────────────── app_user ───────────────────────────────

CREATE TABLE app_user (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         text NOT NULL,
  full_name     text NOT NULL DEFAULT '',
  role          text NOT NULL DEFAULT 'user',
  password_hash text,
  totp_secret   text,
  active        boolean NOT NULL DEFAULT true,
  department    text,
  manager       text,
  phone         text,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_email_uniq UNIQUE (email),
  CONSTRAINT app_user_role_valid CHECK (role IN
    ('admin','sales_manager','appointment_setter','outside_sales_rep','view_only','user'))
);

COMMENT ON TABLE  app_user IS 'One row under D11 (single shared login). Multi-user onboarding inserts rows here; nothing else changes.';
COMMENT ON COLUMN app_user.role IS 'UPDATE is revoked from allied_app in 0004 - privilege escalation guard.';

-- ────────────────────────────── appointment ──────────────────────────────

CREATE TABLE appointment (
  id                          text PRIMARY KEY DEFAULT gen_random_uuid()::text,

  crm_lead_id                 text,
  crm_job_id                  text,
  appointment_record_id       text,

  customer_name               text NOT NULL,
  contact_name                text,
  phone                       text,
  email                       text,
  address                     text,
  city                        text,
  county                      text,

  lead_created_date           date,
  appointment_set_date        date,
  appointment_date            date,
  appointment_time            text,
  demo_date                   date,
  reset_date                  date,
  sale_date                   date,
  owner_status_update_date    date,
  owner_follow_up_date        date,

  original_appointment_setter text,
  rehash_appointment_setter   text,
  original_sales_rep          text,
  rehash_sales_rep            text,

  marketing_source            text,
  referral_source             text,
  source_category             text,
  campaign                    text,

  product                     text,
  business_division           text,
  trade                       text,
  title                       text,

  appointment_status          text NOT NULL DEFAULT 'Set',
  debrief_status              text NOT NULL DEFAULT 'Missing',
  is_sales_appointment        boolean NOT NULL DEFAULT true,
  exclusion_reason            text,
  notes                       text,

  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  created_by                  text NOT NULL DEFAULT coalesce(current_setting('app.user_email', true), 'system')
);

-- ─────────────────────────────── debrief ───────────────────────────────

CREATE TABLE debrief (
  id                           text PRIMARY KEY DEFAULT gen_random_uuid()::text,

  appointment_id               text REFERENCES appointment(id) ON DELETE SET NULL,
  appointment_record_id        text,
  crm_lead_id                  text,
  crm_job_id                   text,
  result_source                text,
  submitted_by                 text NOT NULL,

  customer_name                text NOT NULL,
  phone                        text,
  address                      text,
  city                         text,
  appointment_date             date NOT NULL,

  sales_rep                    text NOT NULL,
  secondary_sales_rep          text,
  primary_rep_split_pct        numeric(5,2) DEFAULT 100,
  secondary_rep_split_pct      numeric(5,2) DEFAULT 0,
  appointment_setter           text NOT NULL,

  product                      text,
  business_division            text,
  trade                        text,
  appointment_type             text,
  appointment_outcome          text NOT NULL,
  decision_maker_status        text,
  one_leg_reason               text,

  products_discussed           text,
  products_presented_other     text,
  first_price_given            numeric(12,2),
  price_2_given                numeric(12,2),
  price_3_given                numeric(12,2),
  additional_prices_given      text,
  prices_given                 integer,

  financing_offered            boolean,
  financing_not_offered_reason text,
  financing_option_presented   text,
  financing_result             text,

  sale_amount                  numeric(12,2),
  sale_close_type              text,
  sale_price_number            text,
  credit_decline               boolean,
  cancellation                 boolean,

  main_objection               text,
  objection_customer_wording   text,
  pre_close_answer             text,
  closing_question_answer      text,

  step7_result                 text,
  walk_of_life_issues          text,
  step7_coaching_notes         text,
  step7_coaching_followup      text,
  step7_things_to_review       text,

  rep_response                 text,
  client_response_1            text,
  rep_response_2               text,
  client_response_2            text,
  rep_response_3               text,
  cancellation_reason          text,

  reset_needed                 boolean,
  reset_status                 text,
  reset_date                   date,
  reset_reason                 text,
  reset_appointment_scheduled  boolean,
  reset_follow_up_notes        text,

  follow_up_needed             boolean,
  follow_up_bucket             text,
  follow_up_date               date,

  estimate_sent_date           timestamptz,
  sale_date                    date,
  sale_signed_date             date,
  lead_referral_date           date,

  notes                        text,
  marketing_source             text,
  referral_source              text,
  self_gen_source              text,
  sales_appointment            text,
  non_sales_reason             text,
  historical_review            text,

  matched                      boolean NOT NULL DEFAULT false,
  data_quality_flag            text,
  manager_review_needed        boolean NOT NULL DEFAULT false,

  contingency_signed           boolean,
  contingency_signed_date      date,
  demo_completed               boolean,
  insurance_outcome            text,
  upgrade_price_1              numeric(12,2),
  upgrade_price_2              numeric(12,2),
  upgrade_price_3              numeric(12,2),
  other_prices_given           boolean,
  other_prices_details         text,
  other_prices_amount          numeric(12,2),
  total_job_price_provided     boolean,
  total_job_price              numeric(12,2),
  upgrade_sold_accepted        boolean,
  accepted_upgrade_amount      numeric(12,2),
  final_contract_signed        boolean,
  final_contract_date          date,

  last_edited_at               timestamptz,
  last_edited_by               text,
  edit_reason                  text,

  created_at                   timestamptz NOT NULL DEFAULT now(),
  updated_at                   timestamptz NOT NULL DEFAULT now(),
  created_by                   text NOT NULL DEFAULT coalesce(current_setting('app.user_email', true), 'system'),

  -- Split-sale invariant: rep credit must never exceed the sale.
  -- Enforced here because repStatsFromDebriefs() in @allied/shared relies on it
  -- to guarantee credited revenue sums to company revenue.
  CONSTRAINT debrief_split_pct_range CHECK (
    (primary_rep_split_pct   IS NULL OR primary_rep_split_pct   BETWEEN 0 AND 100) AND
    (secondary_rep_split_pct IS NULL OR secondary_rep_split_pct BETWEEN 0 AND 100)
  ),
  CONSTRAINT debrief_split_totals_100 CHECK (
    secondary_sales_rep IS NULL OR btrim(secondary_sales_rep) = ''
    OR round(coalesce(primary_rep_split_pct,0) + coalesce(secondary_rep_split_pct,0)) = 100
  )
);

-- ────────────────────────────── list_option ──────────────────────────────

CREATE TABLE list_option (
  id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  category   text NOT NULL,
  value      text NOT NULL,
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL DEFAULT coalesce(current_setting('app.user_email', true), 'system')
);

-- ──────────────────────────── marketing_source ────────────────────────────

CREATE TABLE marketing_source (
  id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  raw_source      text,
  standard_source text NOT NULL,
  source_category text,
  campaign        text,
  active          boolean NOT NULL DEFAULT true,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL DEFAULT coalesce(current_setting('app.user_email', true), 'system')
);

-- ─────────────────────── appointment_import_exclusion ───────────────────────

CREATE TABLE appointment_import_exclusion (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  import_batch_id  text,
  imported_at      timestamptz,
  imported_by      text,
  title            text,
  customer_name    text,
  crm_lead_id      text,
  appointment_date date,
  appointment_time text,
  exclusion_reason text,
  row_type         text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_exclusion_row_type_valid CHECK (row_type IN
    ('excluded_non_sales','deduplicated','invalid_header','error'))
);

-- ─────────────────────────────── sync_run ───────────────────────────────

CREATE TABLE sync_run (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  mode              text NOT NULL,
  status            text NOT NULL DEFAULT 'running',
  date_from         date NOT NULL,
  date_to           date NOT NULL,
  incremental_since timestamptz,
  full_backfill     boolean NOT NULL DEFAULT false,
  checkpoint        text,
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  started_by        text,
  counts            jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_codes       text[] NOT NULL DEFAULT '{}',
  error_message     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_run_mode_valid   CHECK (mode   IN ('dry_run','commit')),
  CONSTRAINT sync_run_status_valid CHECK (status IN ('running','completed','failed','timeout'))
);

COMMENT ON COLUMN sync_run.incremental_since IS
  'Watermark for date_range_type=appointment_updated_date. Never written by the Base44 implementation; see docs/jobprogress-api.md §3.1.';

-- ────────────────────────────── sync_conflict ──────────────────────────────

CREATE TABLE sync_conflict (
  id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  sync_run_id           text REFERENCES sync_run(id) ON DELETE CASCADE,
  category              text NOT NULL,
  reason                text NOT NULL,
  appointment_record_id text,
  crm_lead_id           text,
  crm_job_id            text,
  resolution_status     text NOT NULL DEFAULT 'open',
  details               text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sync_conflict_category_valid CHECK (category IN
    ('classification_conflict','duplicate_candidate','match_fallback','missing_data',
     'missing_result','missing_signed_date','overlapping_run','api_error')),
  CONSTRAINT sync_conflict_resolution_valid CHECK (resolution_status IN ('open','resolved','ignored'))
);

COMMENT ON COLUMN sync_conflict.details IS 'Non-PII description only - this table is an operational log, not a customer record.';

-- ──────────────────────────── updated_at triggers ────────────────────────────

CREATE TRIGGER app_user_updated_at        BEFORE UPDATE ON app_user        FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
CREATE TRIGGER appointment_updated_at     BEFORE UPDATE ON appointment     FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
CREATE TRIGGER debrief_updated_at         BEFORE UPDATE ON debrief         FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
CREATE TRIGGER list_option_updated_at     BEFORE UPDATE ON list_option     FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
CREATE TRIGGER marketing_source_updated_at BEFORE UPDATE ON marketing_source FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();
