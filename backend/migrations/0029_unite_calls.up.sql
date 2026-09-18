-- The phone system, mirrored: who is on Unite, and every outside call.
--
-- unite_user  — the account's extensions from the Address Book API: the
--               unified user id the Voice API wants, the display name (which
--               is how a call is attributed to a rep), and their numbers.
-- unite_call  — one row per call from the Analytics API (legs merged by the
--               vendor). Internal extension-to-extension calls are not kept:
--               they never involve a customer. `external_key` is the outside
--               party's ten-digit key; `jp_customer_id` is the lead it matched
--               through jp_customer_phone, filled by the sync and re-tried on
--               every run so a lead created after the call still catches it.
--
-- A call row carries a customer's phone number, so reads are managers and
-- admins only. Written only by the sync (jobs pool).
CREATE TABLE unite_user (
  id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  unite_user_id  text NOT NULL,
  display_name   text,
  email          text,
  extension      text,
  type           text,
  -- Normalised name, comparable with jp_appointment.sales_rep and the reminder list.
  rep_key        text GENERATED ALWAYS AS (allied_norm(coalesce(display_name, ''))) STORED,
  -- Ten-digit keys of the user's own numbers (DID, mobile).
  numbers        text[] NOT NULL DEFAULT '{}',
  raw            jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unite_user_id_uniq UNIQUE (unite_user_id)
);
CREATE INDEX unite_user_rep_key_idx ON unite_user (rep_key);
CREATE TRIGGER unite_user_updated_at BEFORE UPDATE ON unite_user
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

CREATE TABLE unite_call (
  id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  unite_call_id    text NOT NULL,
  global_call_id   text,
  started_at       timestamptz NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0,
  direction        text NOT NULL,
  from_number      text,
  from_name        text,
  from_user_id     text,
  to_number        text,
  to_name          text,
  to_user_id       text,
  group_name       text,
  -- The outside party's ten-digit key; what a lead is matched on.
  external_key     text,
  -- Our side of the call: the Unite user (rep / call-center) on it.
  rep_user_id      text,
  -- The lead, once matched.
  jp_customer_id   text,
  matched_at       timestamptz,
  raw              jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unite_call_id_uniq UNIQUE (unite_call_id),
  CONSTRAINT unite_call_direction_valid CHECK (direction IN ('inbound', 'outbound'))
);
CREATE INDEX unite_call_started_idx  ON unite_call (started_at DESC);
CREATE INDEX unite_call_key_idx      ON unite_call (external_key) WHERE external_key IS NOT NULL;
CREATE INDEX unite_call_customer_idx ON unite_call (jp_customer_id, started_at DESC) WHERE jp_customer_id IS NOT NULL;
CREATE INDEX unite_call_rep_idx      ON unite_call (rep_user_id, started_at DESC);
CREATE INDEX unite_call_unmatched_idx ON unite_call (external_key) WHERE jp_customer_id IS NULL AND external_key IS NOT NULL;
CREATE TRIGGER unite_call_updated_at BEFORE UPDATE ON unite_call
  FOR EACH ROW EXECUTE FUNCTION allied_set_updated_at();

GRANT SELECT ON unite_user, unite_call TO allied_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON unite_user, unite_call TO allied_jobs;
ALTER TABLE unite_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE unite_call ENABLE ROW LEVEL SECURITY;
CREATE POLICY unite_user_select ON unite_user FOR SELECT USING (allied_is_authenticated());
CREATE POLICY unite_call_select ON unite_call FOR SELECT USING (allied_is_manager());

-- The sync's telemetry row kind.
ALTER TABLE sync_run DROP CONSTRAINT sync_run_kind_valid;
ALTER TABLE sync_run ADD CONSTRAINT sync_run_kind_valid
  CHECK (kind IN ('appointments','schedules','customers','job_stages','sheet_push','unite_calls'));
