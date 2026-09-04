-- Jobs by workflow stage (the production department's "Jobs" screen).
--
-- JobProgress puts every job in exactly one workflow stage. /workflow/stages
-- lists them (code, name, position, colour, live job count); a job carries
-- current_stage and stage_last_modified. The jobs board mirrors the stages
-- and sweeps the jobs in the TRACKED stages (Project Won / Production /
-- Warranty Work — the grouping lives in shared/src/jobStages.js) every ten
-- minutes with the production schedule.

ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages'));

CREATE TABLE jp_workflow_stage (
  id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_stage_id   text,
  code          text NOT NULL,
  name          text NOT NULL,
  position      integer,
  color         text,
  locked        boolean NOT NULL DEFAULT false,
  jobs_count    integer,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jp_workflow_stage_code_uniq UNIQUE (code)
);
CREATE TRIGGER jp_workflow_stage_updated_at BEFORE UPDATE ON jp_workflow_stage
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

-- jp_job grows the stage detail the board needs. current_stage (the name) is
-- already there from the signed-jobs sync; stage_seen_at marks when a stage
-- sweep last saw the job in a tracked stage, so the board can tell "still
-- there" from "moved on since".
ALTER TABLE jp_job ADD COLUMN stage_code          text;
ALTER TABLE jp_job ADD COLUMN stage_color         text;
ALTER TABLE jp_job ADD COLUMN stage_last_modified timestamptz;
ALTER TABLE jp_job ADD COLUMN awarded_date        date;
ALTER TABLE jp_job ADD COLUMN stage_seen_at       timestamptz;
CREATE INDEX jp_job_stage_idx ON jp_job (stage_code) WHERE stage_code IS NOT NULL;

GRANT SELECT ON jp_workflow_stage TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON jp_workflow_stage TO allied_jobs;
ALTER TABLE jp_workflow_stage ENABLE ROW LEVEL SECURITY;
CREATE POLICY jp_workflow_stage_select ON jp_workflow_stage FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());

-- The production role reads jobs, their customers and their locations for the
-- board (it still has no sales appointments or debriefs).
DROP POLICY jp_job_select ON jp_job;
CREATE POLICY jp_job_select ON jp_job FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
DROP POLICY jp_customer_select ON jp_customer;
CREATE POLICY jp_customer_select ON jp_customer FOR SELECT
  USING (allied_is_authenticated() OR allied_is_production());
