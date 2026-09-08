-- Debrief reminder emails.
--
-- Two hours after a sales appointment's start, if the rep has not filed a
-- debrief here, the rep gets one email about it. Who "the rep" is comes from
-- a recipients list kept by an admin — NOT from login accounts, whose
-- addresses are not reliable — keyed by the rep's name exactly as JobProgress
-- spells it. Every send (or failed attempt, or test) is logged.

CREATE TABLE debrief_reminder_recipient (
  id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  -- The rep's name as it appears on CRM appointments (jp_appointment.sales_rep).
  rep_name    text NOT NULL,
  rep_key     text GENERATED ALWAYS AS (allied_norm(rep_name)) STORED,
  email       text,
  active      boolean NOT NULL DEFAULT true,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_by  text NOT NULL DEFAULT coalesce(current_setting('app.user_email', true), 'system'),
  CONSTRAINT debrief_reminder_recipient_key_uniq UNIQUE (rep_key),
  CONSTRAINT debrief_reminder_recipient_email_shape
    CHECK (email IS NULL OR email = '' OR email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);
CREATE TRIGGER debrief_reminder_recipient_updated_at BEFORE UPDATE ON debrief_reminder_recipient
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

CREATE TABLE debrief_reminder (
  id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  jp_appointment_id text NOT NULL,
  appointment_id    text REFERENCES appointment(id) ON DELETE SET NULL,
  rep_name          text,
  recipient_email   text,
  customer_name     text,
  starts_at         timestamptz,
  subject           text,
  -- sent: delivered to the SMTP server; failed: it refused or was unreachable
  -- (retried on later runs, up to a cap); test: an admin's test message.
  status            text NOT NULL,
  error             text,
  sent_by           text NOT NULL DEFAULT 'scheduler',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT debrief_reminder_status_valid CHECK (status IN ('sent', 'failed', 'test'))
);
-- One successful reminder per appointment, ever. Failures may repeat.
CREATE UNIQUE INDEX debrief_reminder_sent_once ON debrief_reminder (jp_appointment_id) WHERE status = 'sent';
CREATE INDEX debrief_reminder_appt_idx ON debrief_reminder (jp_appointment_id);
CREATE INDEX debrief_reminder_created_idx ON debrief_reminder (created_at);

-- Managers maintain the list and read the log; the job (jobs pool) writes the log.
GRANT SELECT, INSERT, UPDATE, DELETE ON debrief_reminder_recipient TO allied_app;
GRANT SELECT ON debrief_reminder TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON debrief_reminder_recipient, debrief_reminder TO allied_jobs;

ALTER TABLE debrief_reminder_recipient ENABLE ROW LEVEL SECURITY;
ALTER TABLE debrief_reminder           ENABLE ROW LEVEL SECURITY;
CREATE POLICY debrief_reminder_recipient_all ON debrief_reminder_recipient FOR ALL
  USING (allied_is_manager()) WITH CHECK (allied_is_manager());
CREATE POLICY debrief_reminder_select ON debrief_reminder FOR SELECT USING (allied_is_manager());
