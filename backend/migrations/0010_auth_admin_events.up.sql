-- Audit kinds for account administration and session management.
--
-- Multi-user onboarding (the migration plan's "in-platform onboarding later")
-- adds actions the original CHECK did not anticipate: an admin creating or
-- changing an account, resetting a password, unlocking a lockout. Each is a
-- privileged action MIGRATION_PLAN.md §5.5 requires in the audit trail.

ALTER TABLE auth_event DROP CONSTRAINT auth_event_kind_valid;
ALTER TABLE auth_event ADD CONSTRAINT auth_event_kind_valid CHECK (event IN
  ('login','logout','login_failed','locked_out','totp_enrolled',
   'totp_failed','session_expired','session_revoked','password_changed',
   'user_created','user_updated','user_unlocked','password_reset'));
