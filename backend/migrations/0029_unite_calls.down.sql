DELETE FROM sync_run WHERE kind = 'unite_calls';
ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages','sheet_push'));
DROP TABLE IF EXISTS unite_call;
DROP TABLE IF EXISTS unite_user;
