DROP TABLE IF EXISTS jp_job_location;
DROP TABLE IF EXISTS jp_schedule;
DROP FUNCTION IF EXISTS allied_is_production();
ALTER TABLE sync_run DROP CONSTRAINT IF EXISTS sync_run_kind_valid;
ALTER TABLE sync_run DROP COLUMN IF EXISTS kind;
