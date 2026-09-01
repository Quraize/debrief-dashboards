-- Row-Level Security: the second of the two authorization layers described in
-- MIGRATION_PLAN.md §5.3. The backend enforces authorization first; these
-- policies exist so that a handler which forgets an ownership check still fails
-- closed at the database.
--
-- Under D11 (one shared login) there is a single identity, so these policies
-- prevent less than they will once onboarding lands. They are built now because
-- retrofitting RLS onto a populated database is materially harder than starting
-- with it, and because the write-own model (D2) is already decided.
--
-- Identity arrives per transaction, not per connection, so a pooled connection
-- cannot leak one request's identity into another:
--
--   SET LOCAL app.user_email = 'someone@allied...';
--   SET LOCAL app.user_role  = 'outside_sales_rep';
--
-- Roles (created by scripts/bootstrap-roles.sql):
--   allied_owner  owns these tables. RLS does not apply to a table owner, and
--                 that is intentional: migrations and the importer run as owner.
--   allied_app    the request path. RLS applies.
--   allied_jobs   background jobs. BYPASSRLS, used deliberately and logged.

-- ─────────────────────────── session helpers ───────────────────────────

CREATE OR REPLACE FUNCTION allied_current_email() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_email', true), '') $$;

CREATE OR REPLACE FUNCTION allied_current_role() RETURNS text
LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.user_role', true), '') $$;

-- "Signed in" means the request carried one of the six known roles. There is no
-- anonymous access to any table: an unset app.user_role fails every policy.
CREATE OR REPLACE FUNCTION allied_is_authenticated() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT allied_current_role() IN
    ('admin','sales_manager','appointment_setter','outside_sales_rep','view_only','user')
$$;

CREATE OR REPLACE FUNCTION allied_is_manager() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT allied_current_role() IN ('admin','sales_manager') $$;

CREATE OR REPLACE FUNCTION allied_is_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$ SELECT allied_current_role() = 'admin' $$;

-- ────────────────────────────── grants ──────────────────────────────

GRANT USAGE ON SCHEMA public TO allied_app, allied_jobs;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  appointment, debrief, list_option, marketing_source,
  appointment_import_exclusion, sync_run, sync_conflict
  TO allied_app, allied_jobs;

-- Privilege-escalation guard on app_user.role.
--
-- This is written as a NARROW GRANT, not a REVOKE, and that distinction is the
-- whole control. A table-level `GRANT UPDATE ON app_user` implicitly covers
-- every column, and a subsequent `REVOKE UPDATE (role)` does NOT claw it back -
-- has_column_privilege() still reports true. Granting column by column is the
-- only form PostgreSQL actually enforces.
--
-- allied_app therefore cannot write `role` at any privilege level, through any
-- policy, even if a policy is later loosened by mistake. Role changes go through
-- allied_jobs (an admin-only backend path), never the request path.
GRANT SELECT ON app_user TO allied_app, allied_jobs;
GRANT INSERT, UPDATE, DELETE ON app_user TO allied_jobs;
GRANT UPDATE (email, full_name, password_hash, totp_secret, active,
              department, manager, phone, last_login_at)
  ON app_user TO allied_app;

GRANT EXECUTE ON FUNCTION allied_current_email(), allied_current_role(),
  allied_is_authenticated(), allied_is_manager(), allied_is_admin()
  TO allied_app, allied_jobs;

-- ───────────────────────── enable + policies ─────────────────────────

ALTER TABLE appointment                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE debrief                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_option                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_source             ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_import_exclusion ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_run                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflict                ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_user                     ENABLE ROW LEVEL SECURITY;

-- appointment: everyone signed in reads (dashboards aggregate across all reps);
-- everyone signed in updates, because submitting a debrief sets debrief_status
-- on the linked appointment; only managers create or delete.
CREATE POLICY appointment_select ON appointment FOR SELECT USING (allied_is_authenticated());
CREATE POLICY appointment_insert ON appointment FOR INSERT WITH CHECK (allied_is_manager());
CREATE POLICY appointment_update ON appointment FOR UPDATE
  USING (allied_is_authenticated()) WITH CHECK (allied_is_authenticated());
CREATE POLICY appointment_delete ON appointment FOR DELETE USING (allied_is_manager());

-- debrief: D2 exactly - read all, write own. Managers and admins may edit any.
CREATE POLICY debrief_select ON debrief FOR SELECT USING (allied_is_authenticated());
CREATE POLICY debrief_insert ON debrief FOR INSERT WITH CHECK (allied_is_authenticated());
CREATE POLICY debrief_update ON debrief FOR UPDATE
  USING      (created_by = allied_current_email() OR allied_is_manager())
  WITH CHECK (created_by = allied_current_email() OR allied_is_manager());
CREATE POLICY debrief_delete ON debrief FOR DELETE USING (allied_is_manager());

-- list_option: everyone reads the dropdowns; managers maintain them.
CREATE POLICY list_option_select ON list_option FOR SELECT USING (allied_is_authenticated());
CREATE POLICY list_option_insert ON list_option FOR INSERT WITH CHECK (allied_is_manager());
CREATE POLICY list_option_update ON list_option FOR UPDATE
  USING (allied_is_manager()) WITH CHECK (allied_is_manager());
CREATE POLICY list_option_delete ON list_option FOR DELETE USING (allied_is_manager());

-- Operational tables: admin only, in every direction.
CREATE POLICY marketing_source_all ON marketing_source FOR ALL
  USING (allied_is_admin()) WITH CHECK (allied_is_admin());
CREATE POLICY import_exclusion_all ON appointment_import_exclusion FOR ALL
  USING (allied_is_admin()) WITH CHECK (allied_is_admin());
CREATE POLICY sync_run_all ON sync_run FOR ALL
  USING (allied_is_admin()) WITH CHECK (allied_is_admin());
CREATE POLICY sync_conflict_all ON sync_conflict FOR ALL
  USING (allied_is_admin()) WITH CHECK (allied_is_admin());

-- app_user: a user sees and edits only their own row; admins see everyone.
-- The role column is unreachable regardless, via the narrow GRANT above.
CREATE POLICY app_user_select ON app_user FOR SELECT
  USING (email = allied_current_email() OR allied_is_admin());
CREATE POLICY app_user_update ON app_user FOR UPDATE
  USING      (email = allied_current_email() OR allied_is_admin())
  WITH CHECK (email = allied_current_email() OR allied_is_admin());
CREATE POLICY app_user_delete ON app_user FOR DELETE USING (allied_is_admin());
