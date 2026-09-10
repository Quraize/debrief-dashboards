DELETE FROM sync_run WHERE kind = 'sheet_push';
ALTER TABLE sync_run DROP CONSTRAINT IF EXISTS sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages'));
