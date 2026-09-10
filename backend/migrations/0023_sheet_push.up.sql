-- The Google Sheet push (production master sheet, [AUTOMATION]WEEKLY JOB
-- SHEET tab) records each run in sync_run like the other jobs, so the admin
-- pages and the dry-run report share one history.
ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages','sheet_push'));
