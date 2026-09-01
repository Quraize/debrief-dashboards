-- The fix for the duplicate-appointment bug (MIGRATION_PLAN.md §3.2, §7.2).
--
-- Base44 could not enforce record identity, so importAppointments and
-- syncLeapJobProgress both matched against a 500-row window and silently
-- re-created anything older as a duplicate on every run.
--
-- identity_key is computed by the database using the same rule as
-- canonicalAppointmentKey() in @allied/shared/salesAppointment. The two
-- implementations are asserted equal in tests/identity.test.ts - if either
-- side drifts, that test fails.
--
-- NULL handling matters here: a plain UNIQUE over three nullable columns would
-- treat every NULL as distinct, so rows with no lead id could duplicate freely.
-- Normalising through coalesce() into a single non-null text key removes that
-- hole without needing NULLS NOT DISTINCT.

ALTER TABLE appointment
  ADD COLUMN identity_key text GENERATED ALWAYS AS (
    allied_norm(crm_lead_id) || '|' ||
    allied_date_key(appointment_date) || '|' ||
    allied_norm(appointment_time)
  ) STORED;

ALTER TABLE appointment
  ADD CONSTRAINT appointment_identity_uniq UNIQUE (identity_key);

COMMENT ON COLUMN appointment.identity_key IS
  'Generated. Mirrors canonicalAppointmentKey() in @allied/shared. Target of ON CONFLICT for idempotent import and sync.';

-- ── Indexes for the actual query patterns ──
-- Dashboards filter by date and group by rep/setter/source; matching looks up
-- by crm_lead_id; the sync status bar reads the latest completed commit.

CREATE INDEX appointment_appointment_date_idx  ON appointment (appointment_date);
CREATE INDEX appointment_crm_lead_id_idx       ON appointment (crm_lead_id) WHERE crm_lead_id IS NOT NULL;
CREATE INDEX appointment_debrief_status_idx    ON appointment (debrief_status);
CREATE INDEX appointment_record_id_idx         ON appointment (appointment_record_id) WHERE appointment_record_id IS NOT NULL;

CREATE INDEX debrief_appointment_date_idx      ON debrief (appointment_date);
CREATE INDEX debrief_sales_rep_idx             ON debrief (sales_rep);
CREATE INDEX debrief_appointment_setter_idx    ON debrief (appointment_setter);
CREATE INDEX debrief_crm_lead_id_idx           ON debrief (crm_lead_id) WHERE crm_lead_id IS NOT NULL;
CREATE INDEX debrief_appointment_id_idx        ON debrief (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX debrief_created_by_idx            ON debrief (created_by);
-- Signed-month attribution reads sale_signed_date with a fallback to
-- appointment_date; this index serves effectiveSaleDate() lookups.
CREATE INDEX debrief_sale_signed_date_idx      ON debrief (sale_signed_date) WHERE sale_signed_date IS NOT NULL;

CREATE INDEX list_option_category_idx          ON list_option (category) WHERE active;
CREATE INDEX sync_run_latest_commit_idx        ON sync_run (mode, status, finished_at DESC);
CREATE INDEX sync_conflict_run_idx             ON sync_conflict (sync_run_id);
CREATE INDEX sync_conflict_open_idx            ON sync_conflict (resolution_status) WHERE resolution_status = 'open';
