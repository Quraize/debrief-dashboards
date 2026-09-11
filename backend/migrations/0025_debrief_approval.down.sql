DROP TRIGGER IF EXISTS debrief_approval_default ON debrief;
DROP FUNCTION IF EXISTS allied_debrief_approval_default();
DROP INDEX IF EXISTS debrief_approval_pending_idx;
ALTER TABLE debrief DROP CONSTRAINT IF EXISTS debrief_approval_status_valid;
ALTER TABLE debrief DROP COLUMN IF EXISTS approval_note;
ALTER TABLE debrief DROP COLUMN IF EXISTS approved_at;
ALTER TABLE debrief DROP COLUMN IF EXISTS approved_by_name;
ALTER TABLE debrief DROP COLUMN IF EXISTS approved_by;
ALTER TABLE debrief DROP COLUMN IF EXISTS approval_status;
