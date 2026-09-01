DROP TABLE IF EXISTS auth_event;
DROP TABLE IF EXISTS session;

ALTER TABLE app_user
  DROP COLUMN IF EXISTS totp_last_step,
  DROP COLUMN IF EXISTS totp_enrolled_at,
  DROP COLUMN IF EXISTS password_changed_at,
  DROP COLUMN IF EXISTS locked_until,
  DROP COLUMN IF EXISTS failed_login_attempts;

-- Restore the column-scoped grant from 0004 (without the columns this
-- migration added, which no longer exist).
REVOKE UPDATE ON app_user FROM allied_app;
GRANT UPDATE (email, full_name, password_hash, totp_secret, active,
              department, manager, phone, last_login_at)
  ON app_user TO allied_app;
