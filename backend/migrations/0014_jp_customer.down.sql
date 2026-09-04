DROP INDEX IF EXISTS jp_job_customer_idx;
ALTER TABLE jp_job DROP COLUMN IF EXISTS jp_customer_id;
DROP INDEX IF EXISTS jp_appointment_customer_idx;
ALTER TABLE jp_appointment DROP COLUMN IF EXISTS jp_customer_id;
DROP TABLE IF EXISTS jp_customer;
DROP TABLE IF EXISTS jp_referral;
ALTER TABLE sync_run DROP CONSTRAINT IF EXISTS sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules'));
