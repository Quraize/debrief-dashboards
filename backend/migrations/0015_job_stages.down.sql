DROP POLICY IF EXISTS jp_customer_select ON jp_customer;
CREATE POLICY jp_customer_select ON jp_customer FOR SELECT USING (allied_is_authenticated());
DROP POLICY IF EXISTS jp_job_select ON jp_job;
CREATE POLICY jp_job_select ON jp_job FOR SELECT USING (allied_is_authenticated());
DROP INDEX IF EXISTS jp_job_stage_idx;
ALTER TABLE jp_job DROP COLUMN IF EXISTS stage_seen_at;
ALTER TABLE jp_job DROP COLUMN IF EXISTS awarded_date;
ALTER TABLE jp_job DROP COLUMN IF EXISTS stage_last_modified;
ALTER TABLE jp_job DROP COLUMN IF EXISTS stage_color;
ALTER TABLE jp_job DROP COLUMN IF EXISTS stage_code;
DROP TABLE IF EXISTS jp_workflow_stage;
ALTER TABLE sync_run DROP CONSTRAINT IF EXISTS sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers'));
