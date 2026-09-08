-- Reverse of 0016: put JobProgress-sourced appointment times back on UTC.
-- Rows merged into hand-entered duplicates on the way up stay merged.
DO $$
DECLARE r record; v_at timestamptz;
BEGIN
  UPDATE appointment SET appointment_time = 'ny ' || appointment_time
   WHERE appointment_record_id IS NOT NULL AND appointment_record_id <> ''
     AND appointment_date IS NOT NULL AND appointment_time ~ '^\d{2}:\d{2}$';
  FOR r IN SELECT id, appointment_date, appointment_time FROM appointment WHERE appointment_time LIKE 'ny %'
  LOOP
    v_at := (r.appointment_date::text || ' ' || substr(r.appointment_time, 4))::timestamp AT TIME ZONE 'America/New_York';
    UPDATE appointment
       SET appointment_date = (v_at AT TIME ZONE 'UTC')::date,
           appointment_time = to_char(v_at AT TIME ZONE 'UTC', 'HH24:MI')
     WHERE id = r.id;
  END LOOP;
END $$;

UPDATE jp_appointment
   SET appointment_date = (starts_at AT TIME ZONE 'UTC')::date,
       appointment_time = to_char(starts_at AT TIME ZONE 'UTC', 'HH24:MI')
 WHERE starts_at IS NOT NULL;

DROP INDEX IF EXISTS jp_appointment_starts_at_idx;
ALTER TABLE jp_appointment DROP COLUMN IF EXISTS starts_at;
