-- Appointments that move or vanish in JobProgress.
--
-- The sync upserts operational appointments on identity (lead + date + time).
-- When the office reschedules an appointment in JobProgress, the same CRM
-- appointment id comes back with a new start, so a NEW row is created and the
-- old one lingers — forever "Missing" in the Open Debrief Queue for a visit
-- that never happened (Annie Li, 2026-09-08 → 09-09). A deleted appointment
-- lingers the same way. The sync now retires both kinds; nothing is erased.

ALTER TABLE appointment ADD COLUMN retired_at     timestamptz;
ALTER TABLE appointment ADD COLUMN retired_reason text;
ALTER TABLE appointment ADD CONSTRAINT appointment_retired_reason_valid
  CHECK (retired_reason IS NULL OR retired_reason IN ('moved', 'missing_from_crm'));
CREATE INDEX appointment_retired_idx ON appointment (retired_at) WHERE retired_at IS NOT NULL;
COMMENT ON COLUMN appointment.retired_at IS
  'Set by the sync when the CRM appointment was rescheduled (a fresh row carries the new time) or no longer exists. debrief_status becomes Superseded so every "Missing" view drops it.';

-- The CRM mirror keeps the same signal (as jp_schedule already does).
ALTER TABLE jp_appointment ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jp_appointment ADD COLUMN deleted_at   timestamptz;
CREATE INDEX jp_appointment_deleted_idx ON jp_appointment (deleted_at) WHERE deleted_at IS NOT NULL;
