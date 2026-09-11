-- Offer the old option again and withdraw the new one. Debrief rows were never
-- rewritten, so there is no data to restore. Only the option this migration
-- created is removed: one added by hand afterwards is left alone.
UPDATE list_option SET active = true
 WHERE category = 'appointment_outcome' AND value = 'DQ — Disqualified';

DELETE FROM list_option
 WHERE category = 'appointment_outcome'
   AND value = 'Demo Completed — DQ: Demo No Sale'
   AND created_by = 'migration:0026';

COMMENT ON COLUMN debrief.dq_reason IS
  'Why the appointment was disqualified and should not be reset. Required by the form for the "No Demo — DQ / Do Not Reset" outcome.';
