-- Rows of the newer kinds cannot satisfy the original constraint; a down
-- migration deliberately trades that audit history for reversibility.
DELETE FROM auth_event WHERE event IN ('user_created','user_updated','user_unlocked','password_reset');

ALTER TABLE auth_event DROP CONSTRAINT auth_event_kind_valid;
ALTER TABLE auth_event ADD CONSTRAINT auth_event_kind_valid CHECK (event IN
  ('login','logout','login_failed','locked_out','totp_enrolled',
   'totp_failed','session_expired','session_revoked','password_changed'));
