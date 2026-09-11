-- A new appointment outcome, "No Demo — DQ / Do Not Reset": the rep went, no
-- demo was given, and the lead was disqualified rather than reset. The
-- managers want to know WHY every time, so the debrief gets a reason field
-- that the form requires whenever this outcome is chosen.
ALTER TABLE debrief ADD COLUMN dq_reason text;
COMMENT ON COLUMN debrief.dq_reason IS
  'Why the appointment was disqualified and should not be reset. Required by the form for the "No Demo — DQ / Do Not Reset" outcome.';

-- The form's outcome dropdown reads list_option, so the option ships with the schema.
INSERT INTO list_option (category, value, created_by)
SELECT 'appointment_outcome', 'No Demo — DQ / Do Not Reset', 'migration:0024'
 WHERE NOT EXISTS (SELECT 1 FROM list_option WHERE category = 'appointment_outcome' AND value = 'No Demo — DQ / Do Not Reset');
