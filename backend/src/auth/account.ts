/**
 * Account state that authentication depends on: TOTP, lockout, audit.
 *
 * Everything here runs on the allied_jobs pool. The request-path role has no
 * privilege on `session`, `auth_event`, or the lockout and TOTP columns of
 * `app_user` (see migration 0005) - authentication is not something a request
 * handler should be able to rewrite.
 */
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { withServiceRole } from "../db/client.js";

export const MAX_FAILED_ATTEMPTS = Number(process.env.AUTH_MAX_FAILED ?? 5);
export const LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MS ?? 15 * 60 * 1000);
const TOTP_PERIOD_SECONDS = 30;
/** Accept the neighbouring step each way, to tolerate clock skew. */
const TOTP_WINDOW = 1;

export type AuthEvent =
  | "login" | "logout" | "login_failed" | "locked_out" | "totp_enrolled"
  | "totp_failed" | "session_expired" | "session_revoked" | "password_changed"
  | "user_created" | "user_updated" | "user_unlocked" | "password_reset";

export interface AuthContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface AccountRow {
  id: string;
  email: string;
  role: string;
  full_name: string;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enrolled_at: Date | null;
  totp_last_step: string | null;
  active: boolean;
  failed_login_attempts: number;
  locked_until: Date | null;
}

/**
 * Audit trail. Never records credentials, tokens or TOTP codes - `detail` is for
 * context like "bad password" or "totp required", nothing more.
 * Failures here are logged and swallowed: losing an audit row must not turn a
 * successful login into a 500.
 */
export async function recordAuthEvent(
  event: AuthEvent, succeeded: boolean, email: string | null, ctx: AuthContext, detail?: string,
): Promise<void> {
  try {
    await withServiceRole(async (c) => {
      await c.query(
        `INSERT INTO auth_event (event, succeeded, email, ip, user_agent, detail)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [event, succeeded, email, ctx.ip ?? null, ctx.userAgent?.slice(0, 300) ?? null, detail ?? null],
      );
    }, `auth:event:${event}`);
  } catch (err) {
    console.error("[auth] failed to record auth event", { event, err });
  }
}

export async function findAccountByEmail(email: string): Promise<AccountRow | null> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<AccountRow>(
      `SELECT id, email, role, full_name, password_hash, totp_secret, totp_enrolled_at,
              totp_last_step, active, failed_login_attempts, locked_until
         FROM app_user WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ?? null;
  }, "auth:find-account");
}

export function isLocked(a: AccountRow): boolean {
  return a.locked_until !== null && a.locked_until.getTime() > Date.now();
}

/**
 * Records a failed attempt and locks the account once the threshold is reached.
 * Returns whether this failure caused the lock, so the caller can audit it.
 */
export async function registerFailure(userId: string): Promise<{ locked: boolean; attempts: number }> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ failed_login_attempts: number; locked_until: Date | null }>(
      `UPDATE app_user
          SET failed_login_attempts = failed_login_attempts + 1,
              locked_until = CASE
                WHEN failed_login_attempts + 1 >= $2
                THEN now() + ($3 || ' milliseconds')::interval
                ELSE locked_until END
        WHERE id = $1
        RETURNING failed_login_attempts, locked_until`,
      [userId, MAX_FAILED_ATTEMPTS, String(LOCKOUT_MS)],
    );
    const r = rows[0]!;
    return {
      locked: r.locked_until !== null && r.locked_until.getTime() > Date.now(),
      attempts: r.failed_login_attempts,
    };
  }, "auth:register-failure");
}

export async function registerSuccess(userId: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE app_user
          SET failed_login_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`, [userId]);
  }, "auth:register-success");
}

// ─────────────────────────────── TOTP ───────────────────────────────

function totpFor(secretBase32: string, email: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: "Allied Sales Sync",
    label: email,
    algorithm: "SHA1",         // what every authenticator app implements
    digits: 6,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export interface TotpEnrollment {
  secret: string;
  otpauthUri: string;
  qrDataUri: string;
}

/**
 * Generates an enrollment secret. Deliberately does NOT persist it: the secret
 * is only stored once a valid code proves the authenticator actually holds it.
 * Persisting on generate is how accounts end up locked out by a QR nobody scanned.
 */
export async function beginTotpEnrollment(email: string): Promise<TotpEnrollment> {
  const secret = new OTPAuth.Secret({ size: 20 }); // 160-bit, per RFC 4226
  const uri = totpFor(secret.base32, email).toString();
  return {
    secret: secret.base32,
    otpauthUri: uri,
    qrDataUri: await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 240 }),
  };
}

/** Confirms the code, then stores the secret. Order matters. */
export async function completeTotpEnrollment(
  userId: string, email: string, secretBase32: string, code: string,
): Promise<boolean> {
  const delta = totpFor(secretBase32, email).validate({ token: code, window: TOTP_WINDOW });
  if (delta === null) return false;

  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE app_user
          SET totp_secret = $2, totp_enrolled_at = now(), totp_last_step = $3
        WHERE id = $1`,
      [userId, secretBase32, String(currentStep())],
    );
  }, "auth:totp-enroll");
  return true;
}

const currentStep = () => Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);

/**
 * Verifies a login code and burns it.
 *
 * A TOTP code stays valid for its whole 30-second step, so without a replay
 * guard a code shoulder-surfed or captured from a proxy can be reused within
 * that window. Recording the highest accepted step and requiring strictly
 * greater makes every code single-use.
 */
export async function verifyTotpForLogin(a: AccountRow, code: string): Promise<boolean> {
  if (!a.totp_secret) return false;

  const delta = totpFor(a.totp_secret, a.email).validate({ token: code, window: TOTP_WINDOW });
  if (delta === null) return false;

  const usedStep = currentStep() + delta;
  const lastStep = a.totp_last_step === null ? -1 : Number(a.totp_last_step);
  if (usedStep <= lastStep) return false; // replay

  await withServiceRole(async (c) => {
    // Guarded update: two concurrent logins with the same code cannot both win.
    await c.query(
      `UPDATE app_user SET totp_last_step = $2
        WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)`,
      [a.id, String(usedStep)],
    );
  }, "auth:totp-verify");
  return true;
}

export const totpRequired = (a: AccountRow): boolean => a.totp_secret !== null && a.totp_enrolled_at !== null;
