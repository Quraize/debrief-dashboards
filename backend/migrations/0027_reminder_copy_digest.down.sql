DELETE FROM debrief_reminder WHERE status = 'digest';
ALTER TABLE debrief_reminder DROP CONSTRAINT debrief_reminder_status_valid;
ALTER TABLE debrief_reminder ADD CONSTRAINT debrief_reminder_status_valid
  CHECK (status IN ('sent', 'failed', 'test'));
ALTER TABLE debrief_reminder DROP COLUMN IF EXISTS cc;
