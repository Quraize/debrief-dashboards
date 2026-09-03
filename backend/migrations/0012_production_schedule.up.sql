-- Production schedule mirror (the dispatch board's data).
--
-- jp_schedule is one row per JobProgress production-calendar entry (GET
-- /schedules, type=schedule) within the sync's rolling window; jp_job_location
-- caches the geocoded job address JobProgress already holds, so pins never
-- need an external geocoder. Both are written only by the schedule sync
-- (jobs pool) and read by the board — production roles, not every user:
-- this is a map of customer addresses.
--
-- The production department may later get its own front door (a separate
-- domain on the same backend); nothing here depends on the sales tables, so
-- it moves as a unit.

-- sync_run gains a discriminator so the two syncs share one telemetry table
-- without the appointment sync's watermark ever reading a schedule run.
ALTER TABLE sync_run ADD COLUMN kind text NOT NULL DEFAULT 'appointments';
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules'));

CREATE OR REPLACE FUNCTION allied_is_production() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN ('admin','sales_manager','project_manager','production')
$$;

CREATE TABLE jp_schedule (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_schedule_id   text NOT NULL,
  jp_job_id        text,
  jp_customer_id   text,
  title            text,
  description      text,
  start_at         timestamptz NOT NULL,
  end_at           timestamptz NOT NULL,
  full_day         boolean NOT NULL DEFAULT false,
  is_completed     boolean NOT NULL DEFAULT false,
  is_recurring     boolean NOT NULL DEFAULT false,
  series_id        text,
  -- Parsed from the office's title convention ("RR: Town/Street/Customer").
  job_type_code    text,
  job_number       text,
  job_name         text,
  job_stage        text,
  job_insurance    boolean,
  customer_name    text,
  crew_ids         text[] NOT NULL DEFAULT '{}',
  crew_names       text[] NOT NULL DEFAULT '{}',
  trades           text[] NOT NULL DEFAULT '{}',
  work_types       text[] NOT NULL DEFAULT '{}',
  jp_created_at    timestamptz,
  jp_updated_at    timestamptz,
  -- A schedule that vanishes from JobProgress (deleted or moved out of the
  -- window) is retired, not erased: the board hides it, the history stays.
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_schedule_jp_id_uniq UNIQUE (jp_schedule_id)
);

CREATE INDEX jp_schedule_window_idx ON jp_schedule (start_at, end_at) WHERE deleted_at IS NULL;
CREATE INDEX jp_schedule_job_idx ON jp_schedule (jp_job_id);

CREATE TRIGGER jp_schedule_updated_at BEFORE UPDATE ON jp_schedule
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

CREATE TABLE jp_job_location (
  jp_job_id      text PRIMARY KEY,
  address        text,
  address_line_1 text,
  city           text,
  state          text,
  zip            text,
  lat            double precision,
  lng            double precision,
  source         text NOT NULL DEFAULT 'jobprogress',
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER jp_job_location_updated_at BEFORE UPDATE ON jp_job_location
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

GRANT SELECT ON jp_schedule, jp_job_location TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_schedule, jp_job_location TO allied_jobs;

ALTER TABLE jp_schedule     ENABLE ROW LEVEL SECURITY;
ALTER TABLE jp_job_location ENABLE ROW LEVEL SECURITY;

CREATE POLICY jp_schedule_select ON jp_schedule FOR SELECT
  USING (allied_is_production());
CREATE POLICY jp_job_location_select ON jp_job_location FOR SELECT
  USING (allied_is_production());
