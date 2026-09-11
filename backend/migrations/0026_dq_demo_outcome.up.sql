-- Two DQ outcomes sat next to each other on the debrief form and only one of
-- them asked the rep for a reason.
--
-- "DQ — Disqualified" is the old Base44-era option: it meant "never a real
-- opportunity" and was left out of the appointment-quality metrics entirely.
-- Reps were picking it, expecting the reason box that migration 0024 attached
-- to "No Demo — DQ / Do Not Reset", and getting nothing.
--
-- It is replaced by "Demo Completed — DQ: Demo No Sale", which is what the
-- managers actually want to record: the demo WAS given, nothing sold, and the
-- lead is disqualified rather than reset. Both DQ outcomes now require a
-- reason on the form.
--
-- The old option is DEACTIVATED rather than renamed, and existing debriefs are
-- deliberately NOT rewritten. Rows filed as "DQ — Disqualified" were filed
-- under the old meaning; renaming them would silently move them into the demo
-- count and change last month's demo rate. They keep the old value and the old
-- treatment, and the form no longer offers it. The notice below says how many
-- there are, so the call to convert them can be made on real numbers.

DO $$
DECLARE
  retired     integer;
  legacy_rows integer;
BEGIN
  -- The form's dropdown reads list_option and shows only active rows.
  UPDATE list_option SET active = false
   WHERE category = 'appointment_outcome' AND value = 'DQ — Disqualified' AND active;
  GET DIAGNOSTICS retired = ROW_COUNT;

  INSERT INTO list_option (category, value, created_by)
  SELECT 'appointment_outcome', 'Demo Completed — DQ: Demo No Sale', 'migration:0026'
   WHERE NOT EXISTS (SELECT 1 FROM list_option
                      WHERE category = 'appointment_outcome' AND value = 'Demo Completed — DQ: Demo No Sale');

  -- 0024's option, re-asserted: on a database where it was removed by hand the
  -- form would be missing the no-demo DQ entirely.
  INSERT INTO list_option (category, value, created_by)
  SELECT 'appointment_outcome', 'No Demo — DQ / Do Not Reset', 'migration:0026'
   WHERE NOT EXISTS (SELECT 1 FROM list_option
                      WHERE category = 'appointment_outcome' AND value = 'No Demo — DQ / Do Not Reset');

  SELECT count(*) INTO legacy_rows FROM debrief WHERE appointment_outcome = 'DQ — Disqualified';
  RAISE NOTICE '0026: retired % dropdown option(s); % existing debrief(s) keep the retired "DQ — Disqualified" value.',
    retired, legacy_rows;
END $$;

COMMENT ON COLUMN debrief.dq_reason IS
  'Why the lead was disqualified instead of reset. Required by the form for both DQ outcomes: '
  '"No Demo — DQ / Do Not Reset" and "Demo Completed — DQ: Demo No Sale".';
