-- Debrief reminders: a manager's copy, and the missing-debrief digest.
--
-- Every reminder that goes to a rep can now also go to the addresses in
-- DEBRIEF_REMINDER_CC (the ops manager). The log records who was copied, so
-- "did Ashley get it too?" is answerable from the Sent reminders table.
--
-- The digest is one email listing everything currently in the Missing Debrief
-- queue, sent on request from the admin page. It is logged with its own status
-- so it never collides with the one-reminder-per-appointment rule.
ALTER TABLE debrief_reminder ADD COLUMN cc text;
COMMENT ON COLUMN debrief_reminder.cc IS 'Addresses copied on the message (DEBRIEF_REMINDER_CC), comma-separated; NULL when none.';

ALTER TABLE debrief_reminder DROP CONSTRAINT debrief_reminder_status_valid;
ALTER TABLE debrief_reminder ADD CONSTRAINT debrief_reminder_status_valid
  CHECK (status IN ('sent', 'failed', 'test', 'digest'));
