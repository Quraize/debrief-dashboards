/**
 * Server-side session lifecycle.
 *
 * All queries run on the allied_jobs pool: authentication happens before an
 * identity exists, so it cannot run inside a user's RLS context, and the
 * request-path role has no privileges on the session table at all (0005).
 */
import type pg from "pg";
import { withServiceRole } from "../db/client.js";
import { generateToken, hashToken } from "./crypto.js";

/** Pushed forward on use. A session unused for this long is dead. */
export const IDLE_TTL_MS = Number(process.env.SESSION_IDLE_TTL_MS ?? 12 * 60 * 60 * 1000);
/** Fixed at login and never extended, so an active session cannot live forever. */
export const ABSOLUTE_TTL_MS = Number(process.env.SESSION_ABSOLUTE_TTL_MS ?? 7 * 24 * 60 * 60 * 1000);

export interface SessionUser {
  id: string;
  email: string;
  role: string;
  fullName: string;
}

export interface NewSession {
  /** Raw token - goes in the cookie, is never stored. */
  token: string;
  /** Raw CSRF token - goes in a JS-readable cookie and must be echoed in a header. */
  csrfToken: string;
  expiresAt: Date;
}

export interface ResolvedSession {
  user: SessionUser;
  csrfTokenHash: string;
  tokenHash: string;
}

interface Meta { ip?: string | undefined; userAgent?: string | undefined }

export async function createSession(userId: string, meta: Meta = {}): Promise<NewSession> {
  const token = generateToken();
  const csrfToken = generateToken();
  const now = Date.now();
  const expiresAt = new Date(now + IDLE_TTL_MS);
  const absoluteExpiresAt = new Date(now + ABSOLUTE_TTL_MS);

  await withServiceRole(async (c) => {
    await c.query(
      `INSERT INTO session (token_hash, user_id, expires_at, absolute_expires_at, ip, user_agent, csrf_token_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hashToken(token), userId, expiresAt, absoluteExpiresAt,
       meta.ip ?? null, meta.userAgent?.slice(0, 300) ?? null, hashToken(csrfToken)],
    );
  }, "auth:create-session");

  return { token, csrfToken, expiresAt };
}

/**
 * Resolves a raw cookie token to a user, sliding the idle window forward.
 *
 * Returns null for anything not currently valid - unknown, revoked, idle-expired
 * or past its absolute expiry - without distinguishing between them to the
 * caller. The caller has no legitimate use for the difference, and the client
 * has no business learning it.
 */
export async function resolveSession(rawToken: string): Promise<ResolvedSession | null> {
  const tokenHash = hashToken(rawToken);

  return withServiceRole(async (c: pg.PoolClient) => {
    const { rows } = await c.query<{
      user_id: string; email: string; role: string; full_name: string;
      csrf_token_hash: string; active: boolean;
    }>(
      `SELECT s.user_id, u.email, u.role, u.full_name, s.csrf_token_hash, u.active
         FROM session s
         JOIN app_user u ON u.id = s.user_id
        WHERE s.token_hash = $1
          AND s.revoked_at IS NULL
          AND s.expires_at > now()
          AND s.absolute_expires_at > now()`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;

    // A deactivated account loses access immediately, without waiting for its
    // sessions to expire.
    if (!row.active) {
      await c.query(`UPDATE session SET revoked_at = now() WHERE token_hash = $1`, [tokenHash]);
      return null;
    }

    // Slide the idle window, but never past the absolute expiry.
    await c.query(
      `UPDATE session
          SET last_seen_at = now(),
              expires_at   = LEAST(now() + ($2 || ' milliseconds')::interval, absolute_expires_at)
        WHERE token_hash = $1`,
      [tokenHash, String(IDLE_TTL_MS)],
    );

    return {
      user: { id: row.user_id, email: row.email, role: row.role, fullName: row.full_name },
      csrfTokenHash: row.csrf_token_hash,
      tokenHash,
    };
  }, "auth:resolve-session", { quiet: true });
}

export async function revokeSession(rawToken: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE session SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(rawToken)],
    );
  }, "auth:revoke-session");
}

/**
 * Revokes a user's sessions. Used on password change, on second-factor
 * enrollment, and by a future "sign out everywhere".
 *
 * `keepRawToken` spares the caller's own session. Enrolling TOTP should
 * invalidate any session that might have been stolen, but logging the user out
 * of the tab they just enrolled from is a self-inflicted wound - they have, at
 * that exact moment, proved possession of the new factor.
 */
export async function revokeAllSessionsFor(userId: string, keepRawToken?: string): Promise<number> {
  return withServiceRole(async (c) => {
    const keep = keepRawToken ? hashToken(keepRawToken) : null;
    const { rowCount } = await c.query(
      `UPDATE session SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL
          AND ($2::text IS NULL OR token_hash <> $2)`,
      [userId, keep]);
    return rowCount ?? 0;
  }, "auth:revoke-all-sessions");
}

/** Housekeeping - expired rows carry no privilege, they are just clutter. */
export async function purgeExpiredSessions(olderThanDays = 30): Promise<number> {
  return withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `DELETE FROM session
        WHERE absolute_expires_at < now() - ($1 || ' days')::interval`, [String(olderThanDays)]);
    return rowCount ?? 0;
  }, "auth:purge-sessions");
}
