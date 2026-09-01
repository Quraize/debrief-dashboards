DROP POLICY IF EXISTS app_user_delete ON app_user;
DROP POLICY IF EXISTS app_user_update ON app_user;
DROP POLICY IF EXISTS app_user_select ON app_user;
DROP POLICY IF EXISTS sync_conflict_all ON sync_conflict;
DROP POLICY IF EXISTS sync_run_all ON sync_run;
DROP POLICY IF EXISTS import_exclusion_all ON appointment_import_exclusion;
DROP POLICY IF EXISTS marketing_source_all ON marketing_source;
DROP POLICY IF EXISTS list_option_delete ON list_option;
DROP POLICY IF EXISTS list_option_update ON list_option;
DROP POLICY IF EXISTS list_option_insert ON list_option;
DROP POLICY IF EXISTS list_option_select ON list_option;
DROP POLICY IF EXISTS debrief_delete ON debrief;
DROP POLICY IF EXISTS debrief_update ON debrief;
DROP POLICY IF EXISTS debrief_insert ON debrief;
DROP POLICY IF EXISTS debrief_select ON debrief;
DROP POLICY IF EXISTS appointment_delete ON appointment;
DROP POLICY IF EXISTS appointment_update ON appointment;
DROP POLICY IF EXISTS appointment_insert ON appointment;
DROP POLICY IF EXISTS appointment_select ON appointment;

ALTER TABLE app_user                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE sync_conflict                DISABLE ROW LEVEL SECURITY;
ALTER TABLE sync_run                     DISABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_import_exclusion DISABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_source             DISABLE ROW LEVEL SECURITY;
ALTER TABLE list_option                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE debrief                      DISABLE ROW LEVEL SECURITY;
ALTER TABLE appointment                  DISABLE ROW LEVEL SECURITY;

REVOKE ALL ON appointment, debrief, list_option, marketing_source,
  appointment_import_exclusion, sync_run, sync_conflict, app_user
  FROM allied_app, allied_jobs;
REVOKE USAGE ON SCHEMA public FROM allied_app, allied_jobs;

DROP FUNCTION IF EXISTS allied_is_admin();
DROP FUNCTION IF EXISTS allied_is_manager();
DROP FUNCTION IF EXISTS allied_is_authenticated();
DROP FUNCTION IF EXISTS allied_current_role();
DROP FUNCTION IF EXISTS allied_current_email();
