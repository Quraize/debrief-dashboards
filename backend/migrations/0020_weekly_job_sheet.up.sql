-- Weekly Job Sheet feed: the production master sheet's WEEKLY JOB SHEET tab,
-- one row per job in production, filled from JobProgress instead of by hand.
--
-- The tracked-stage sweep (0015) already mirrors every job in a Project Won /
-- Production / Warranty stage. The sheet additionally needs the sales rep and
-- the sub-contractor(s) on the job (both `includes[]` on the jobs listing),
-- the completion date, and the two financial_summary figures the sheet's
-- "Total Payments Received" and "Balance Owed" columns hold. Gross, change
-- orders and total revenue were already here (0007).
--
-- NULL money means "not fetched yet" and is shown as blank, never as $0.

ALTER TABLE jp_job ADD COLUMN rep_names              text;
ALTER TABLE jp_job ADD COLUMN sub_contractor_names   text;
ALTER TABLE jp_job ADD COLUMN completion_date        date;
ALTER TABLE jp_job ADD COLUMN total_payment_received numeric(12,2);
ALTER TABLE jp_job ADD COLUMN total_amount_owed      numeric(12,2);

COMMENT ON COLUMN jp_job.rep_names IS
  'Sales rep(s) on the job in JobProgress (the `reps` include), comma-separated. Only written by sweeps that request the include.';
COMMENT ON COLUMN jp_job.sub_contractor_names IS
  'Sub-contractor(s) assigned to the job in JobProgress (the `sub_contractors` include), comma-separated.';
COMMENT ON COLUMN jp_job.total_payment_received IS
  'From GET /jobs/{id}/financial_summary (or the listing''s financial_details include). The sheet''s "Total Payments Received".';
COMMENT ON COLUMN jp_job.total_amount_owed IS
  'From the same source. The sheet''s "Balance Owed".';
