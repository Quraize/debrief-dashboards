-- Manager approval for "No Demo — DQ / Do Not Reset" debriefs.
--
-- A rep who disqualifies a lead instead of resetting it takes that
-- opportunity off the board, so a manager (admin, sales manager or project
-- manager) confirms each one. Until approved the debrief still exists — it
-- closes the Open Debrief Queue item and is editable — but the dashboards
-- and Results Review leave it out (shared/src/debriefApproval.js).
--
-- approval_status: NULL for outcomes that need no approval; 'pending',
-- 'approved' or 'rejected' for the DQ outcome. The trigger keeps it honest
-- whatever client wrote the row: the DQ outcome always starts pending, and a
-- row that leaves that outcome drops its approval.

ALTER TABLE debrief ADD COLUMN approval_status   text;
ALTER TABLE debrief ADD COLUMN approved_by       text;
ALTER TABLE debrief ADD COLUMN approved_by_name  text;
ALTER TABLE debrief ADD COLUMN approved_at       timestamptz;
ALTER TABLE debrief ADD COLUMN approval_note     text;
ALTER TABLE debrief ADD CONSTRAINT debrief_approval_status_valid
  CHECK (approval_status IS NULL OR approval_status IN ('pending', 'approved', 'rejected'));
CREATE INDEX debrief_approval_pending_idx ON debrief (approval_status) WHERE approval_status IS NOT NULL;

CREATE OR REPLACE FUNCTION allied_debrief_approval_default() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.appointment_outcome = 'No Demo — DQ / Do Not Reset' THEN
    IF NEW.approval_status IS NULL THEN NEW.approval_status := 'pending'; END IF;
  ELSE
    NEW.approval_status := NULL;
    NEW.approved_by := NULL;
    NEW.approved_by_name := NULL;
    NEW.approved_at := NULL;
    NEW.approval_note := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER debrief_approval_default BEFORE INSERT OR UPDATE ON debrief
  FOR EACH ROW EXECUTE FUNCTION allied_debrief_approval_default();

-- Any such debrief already filed starts in the queue.
UPDATE debrief SET approval_status = 'pending'
 WHERE appointment_outcome = 'No Demo — DQ / Do Not Reset' AND approval_status IS NULL;
