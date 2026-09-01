-- Server-side sessions, lockout state, and an auth audit trail.
--
-- Design notes that matter:
--
--  * Session tokens are stored HASHED. The cookie carries the raw token; the
--    database stores only sha256(token). A dump of this table therefore grants
--    nobody a session. SHA-256 (not argon2) is correct here: the token is 256
--    bits of CSPRNG output, so there is nothing to brute-force and no reason to
--    pay a KDF cost on every request.
--
--  * Two expiries, not one. `expires_at` is the idle timeout, pushed forward as
--    the session is used; `absolute_expires_at` is fixed at login and never
--    moves, so a continuously-active session still cannot live forever.
--
--  * These tables are NOT granted to allied_app. Authentication happens before
--    an identity exists, so it cannot run under a user's RLS context - it uses
--    the allied_jobs pool instead. The practical benefit: a SQL injection in any
--    request handler cannot read or forge sessions, because that connection has
--    no privileges on this table at all.
--
--  * RLS is enabled with NO policies, which denies everything by default. It is
--    redundant while the grants above hold, and becomes the safety net the day
--    somebody loosens them.

-- ─────────────────────────────── session ───────────────────────────────

CREATE TABLE session (
  -- sha256 of the raw token, hex. Never the token itself.
  token_hash          text PRIMARY KEY,
  user_id             text NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz,
  -- Double-submit CSRF: sha256 of the token handed to the client in a
  -- JS-readable cookie, which it must echo back in the X-CSRF-Token header.
  -- Bound to the session, so a token from one session is useless in another.
  csrf_token_hash     text NOT NULL,
  -- Recorded for the audit trail and for "sign out everywhere" UX later.
  ip                  text,
  user_agent          text,
  CONSTRAINT session_absolute_after_idle CHECK (absolute_expires_at >= expires_at)
);

CREATE INDEX session_user_idx    ON session (user_id);
CREATE INDEX session_expiry_idx  ON session (expires_at) WHERE revoked_at IS NULL;

COMMENT ON TABLE session IS 'Server-side sessions. Deliberately not reachable by allied_app; the auth layer uses the allied_jobs pool.';

-- ─────────────────────────── app_user additions ───────────────────────────

ALTER TABLE app_user
  ADD COLUMN failed_login_attempts integer     NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN password_changed_at   timestamptz,
  ADD COLUMN totp_enrolled_at      timestamptz,
  -- Highest TOTP time-step already accepted. A code is single-use: replaying a
  -- captured one within its 30s window is rejected because its step is not
  -- greater than this.
  ADD COLUMN totp_last_step        bigint;

-- The request path may not write lockout or TOTP state either; those are
-- authentication concerns, handled through allied_jobs. Re-granting explicitly
-- because the column list in 0004 predates these columns.
REVOKE UPDATE ON app_user FROM allied_app;
GRANT UPDATE (email, full_name, password_hash, active,
              department, manager, phone, last_login_at)
  ON app_user TO allied_app;

-- ────────────────────────────── auth_event ──────────────────────────────

-- Append-only audit trail (MIGRATION_PLAN.md §5.5). Under D11 there is one
-- shared credential and therefore no per-person attribution at the auth layer -
-- which makes knowing WHEN it was used, from WHERE, and whether anyone is
-- guessing at it, considerably more important, not less.
CREATE TABLE auth_event (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event      text        NOT NULL,
  email      text,
  succeeded  boolean     NOT NULL,
  ip         text,
  user_agent text,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auth_event_kind_valid CHECK (event IN
    ('login','logout','login_failed','locked_out','totp_enrolled',
     'totp_failed','session_expired','session_revoked','password_changed'))
);

CREATE INDEX auth_event_created_idx ON auth_event (created_at DESC);
CREATE INDEX auth_event_failures_idx ON auth_event (email, created_at DESC) WHERE NOT succeeded;

COMMENT ON COLUMN auth_event.detail IS 'Never store credentials, tokens, or TOTP codes here.';

-- ────────────────────────── grants + fail-closed RLS ──────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON session    TO allied_jobs;
GRANT SELECT, INSERT                  ON auth_event TO allied_jobs;
GRANT USAGE, SELECT ON SEQUENCE auth_event_id_seq  TO allied_jobs;

-- Enabled with no policies: everything is denied except the owner and
-- BYPASSRLS roles. If someone later grants allied_app access by accident, this
-- still refuses until a policy is written deliberately.
ALTER TABLE session    ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_event ENABLE ROW LEVEL SECURITY;
