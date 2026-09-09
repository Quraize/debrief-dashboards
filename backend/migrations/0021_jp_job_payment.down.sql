ALTER TABLE jp_job DROP COLUMN IF EXISTS payments_fetched_total;
ALTER TABLE jp_job DROP COLUMN IF EXISTS payments_fetched_at;
DROP TABLE IF EXISTS jp_job_payment;
