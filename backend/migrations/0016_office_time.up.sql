-- Appointment times on the office clock.
--
-- JobProgress emits start_date_time in UTC. The appointment sync (and the
-- Base44 one before it) sliced the date and time straight out of that string,
-- so a 5 PM Eastern estimate was stored as 21:00 and, once the clocks change
-- in November, a 7 PM one would have landed on the next calendar day. From
-- this migration on, the sync converts to America/New_York before storing;
-- here the rows already stored are moved to the same clock.
--
-- Rows that came from JobProgress are the ones carrying its appointment id.
-- Anything else (hand-entered, imported from spreadsheets) already held wall-
-- clock times and is left untouched.

-- ── CRM mirror: keep the exact instant, derive date/time from it ──
ALTER TABLE jp_appointment ADD COLUMN starts_at timestamptz;

UPDATE jp_appointment
   SET starts_at = (replace(raw->>'start_date_time', 'T', ' '))::timestamp AT TIME ZONE 'UTC'
 WHERE raw->>'start_date_time' ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}';

-- Mirror rows whose raw payload lacks the start (none expected): the stored
-- date/time were the UTC values, so rebuild the instant from them.
UPDATE jp_appointment
   SET starts_at = (appointment_date::text || ' ' || appointment_time)::timestamp AT TIME ZONE 'UTC'
 WHERE starts_at IS NULL AND appointment_date IS NOT NULL AND appointment_time ~ '^\d{2}:\d{2}$';

UPDATE jp_appointment
   SET appointment_date = (starts_at AT TIME ZONE 'America/New_York')::date,
       appointment_time = to_char(starts_at AT TIME ZONE 'America/New_York', 'HH24:MI')
 WHERE starts_at IS NOT NULL;

CREATE INDEX jp_appointment_starts_at_idx ON jp_appointment (starts_at);

COMMENT ON COLUMN jp_appointment.starts_at IS
  'Exact start instant from the API (UTC). appointment_date/appointment_time are this instant on the office clock (America/New_York).';

-- ── Operational appointments: same conversion, identity_key included ──
-- identity_key is generated from lead + date + time, so moving a time changes
-- the key. Two steps keep every intermediate state unique: first park the
-- JobProgress rows on a marked time ("utc 14:00") that cannot equal any real
-- key, then convert. A converted key that would equal a non-JobProgress row's
-- key means the same appointment was also imported by hand with its real
-- time: the two are merged (debriefs repointed, status kept) and the UTC copy
-- dropped.
DO $$
DECLARE
  r record;
  v_at timestamptz; v_date date; v_time text; v_key text; v_existing text;
  n_fixed int := 0; n_merged int := 0;
BEGIN
  UPDATE appointment SET appointment_time = 'utc ' || appointment_time
   WHERE appointment_record_id IS NOT NULL AND appointment_record_id <> ''
     AND appointment_date IS NOT NULL AND appointment_time ~ '^\d{2}:\d{2}$';

  FOR r IN SELECT id, crm_lead_id, appointment_date, appointment_time, debrief_status, appointment_record_id
             FROM appointment WHERE appointment_time LIKE 'utc %'
  LOOP
    v_at   := (r.appointment_date::text || ' ' || substr(r.appointment_time, 5))::timestamp AT TIME ZONE 'UTC';
    v_date := (v_at AT TIME ZONE 'America/New_York')::date;
    v_time := to_char(v_at AT TIME ZONE 'America/New_York', 'HH24:MI');
    v_key  := allied_norm(r.crm_lead_id) || '|' || allied_date_key(v_date) || '|' || allied_norm(v_time);

    SELECT id INTO v_existing FROM appointment WHERE identity_key = v_key AND id <> r.id;
    IF v_existing IS NULL THEN
      UPDATE appointment SET appointment_date = v_date, appointment_time = v_time WHERE id = r.id;
      n_fixed := n_fixed + 1;
    ELSE
      UPDATE debrief SET appointment_id = v_existing WHERE appointment_id = r.id;
      UPDATE appointment
         SET appointment_record_id = coalesce(nullif(appointment_record_id, ''), r.appointment_record_id),
             debrief_status = CASE
               WHEN debrief_status IN ('Submitted', 'Approved') THEN debrief_status
               WHEN r.debrief_status IN ('Submitted', 'Approved') THEN r.debrief_status
               ELSE debrief_status END
       WHERE id = v_existing;
      DELETE FROM appointment WHERE id = r.id;
      n_merged := n_merged + 1;
    END IF;
  END LOOP;

  RAISE NOTICE '0016_office_time: % appointment rows moved to the office clock, % merged into hand-entered rows', n_fixed, n_merged;
END $$;
