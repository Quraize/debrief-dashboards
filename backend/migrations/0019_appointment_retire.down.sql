UPDATE appointment SET debrief_status = 'Missing' WHERE debrief_status = 'Superseded';
DROP INDEX IF EXISTS jp_appointment_deleted_idx;
ALTER TABLE jp_appointment DROP COLUMN IF EXISTS deleted_at;
ALTER TABLE jp_appointment DROP COLUMN IF EXISTS last_seen_at;
DROP INDEX IF EXISTS appointment_retired_idx;
ALTER TABLE appointment DROP CONSTRAINT IF EXISTS appointment_retired_reason_valid;
ALTER TABLE appointment DROP COLUMN IF EXISTS retired_reason;
ALTER TABLE appointment DROP COLUMN IF EXISTS retired_at;
