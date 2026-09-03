/**
 * Account and session management — the operational half of authentication.
 *
 * Self-service: a user changes their own password, sees their active sessions,
 * revokes one, or signs out everywhere else. Administration: create accounts,
 * change roles, disable/enable, unlock, reset a password, revoke someone's
 * sessions. All of it sits on the existing session model (hashed server-side
 * sessions) — nothing here introduces a second credential type.
 *
 * Runs on the allied_jobs pool (D19): the request-path role has no privilege
 * on `session` or on app_user's lockout/password columns, by design.
 */
import { withServiceRole } from "../db/client.js";
import { hashPassword, verifyPassword, hashToken } from "./crypto.js";
import { revokeAllSessionsFor } from "./session.js";
import { ROLES } from "@allied/shared/constants";

/** Mirrors shared ROLE_LABELS and the DB constraint (migrations 0002/0011). */
export const VALID_ROLES: readonly string[] = ROLES;
export type Role = string;

/** Sessions are identified to clients by a 12-hex prefix of the token hash:
 *  useless for authentication, unique enough within one user's sessions. */
const SESSION_ID_RE = /^[0-9a-f]{12}$/;

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number; expose: boolean };
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

// ─────────────────────────── self-service ───────────────────────────

export interface AccountInfo {
  id: string;
  email: string;
  fullName: string;
  role: string;
  totpEnrolled: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
}

export async function getAccount(userId: string): Promise<AccountInfo | null> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{
      id: string; email: string; full_name: string; role: string;
      totp_enrolled_at: Date | null; password_changed_at: Date | null; last_login_at: Date | null;
    }>(`SELECT id, email, full_name, role, totp_enrolled_at, password_changed_at, last_login_at
          FROM app_user WHERE id = $1`, [userId]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, email: r.email, fullName: r.full_name, role: r.role,
      totpEnrolled: r.totp_enrolled_at !== null,
      passwordChangedAt: r.password_changed_at?.toISOString() ?? null,
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
    };
  }, "auth:get-account", { quiet: true });
}

export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

export async function listSessions(userId: string, currentRawToken?: string): Promise<SessionInfo[]> {
  const currentHash = currentRawToken ? hashToken(currentRawToken) : null;
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{
      token_hash: string; created_at: Date; last_seen_at: Date; expires_at: Date;
      ip: string | null; user_agent: string | null;
    }>(`SELECT token_hash, created_at, last_seen_at, expires_at, ip, user_agent
          FROM session
         WHERE user_id = $1 AND revoked_at IS NULL
           AND expires_at > now() AND absolute_expires_at > now()
         ORDER BY last_seen_at DESC`, [userId]);
    return rows.map((r) => ({
      id: r.token_hash.slice(0, 12),
      createdAt: r.created_at.toISOString(),
      lastSeenAt: r.last_seen_at.toISOString(),
      expiresAt: r.expires_at.toISOString(),
      ip: r.ip,
      userAgent: r.user_agent,
      current: r.token_hash === currentHash,
    }));
  }, "auth:list-sessions", { quiet: true });
}

/** Revokes one of the user's OWN sessions. Returns false when nothing matched. */
export async function revokeSessionById(userId: string, sessionId: string): Promise<boolean> {
  if (!SESSION_ID_RE.test(sessionId)) throw httpError("Invalid session id", 400);
  return withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE session SET revoked_at = now()
        WHERE user_id = $1 AND revoked_at IS NULL AND left(token_hash, 12) = $2`,
      [userId, sessionId]);
    return (rowCount ?? 0) > 0;
  }, "auth:revoke-session-by-id");
}

/**
 * Self-service password change. Requires the current password — a stolen
 * session must not be enough to lock the real owner out. Every OTHER session
 * is revoked; the one making the change survives (it just proved knowledge of
 * both passwords).
 */
export async function changeOwnPassword(
  userId: string, currentPassword: string, newPassword: string, keepRawToken?: string,
): Promise<{ otherSessionsRevoked: number }> {
  const row = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ password_hash: string | null }>(
      `SELECT password_hash FROM app_user WHERE id = $1`, [userId]);
    return rows[0] ?? null;
  }, "auth:load-password", { quiet: true });
  if (!row) throw httpError("Account not found", 404);
  if (!await verifyPassword(row.password_hash, currentPassword)) {
    throw httpError("Current password is incorrect", 400);
  }
  if (newPassword === currentPassword) throw httpError("New password must differ from the current one", 400);

  let hash: string;
  try {
    hash = await hashPassword(newPassword); // enforces the minimum length
  } catch (err) {
    throw httpError((err as Error).message, 400);
  }
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE app_user SET password_hash = $2, password_changed_at = now() WHERE id = $1`,
      [userId, hash]);
  }, "auth:change-password");
  const otherSessionsRevoked = await revokeAllSessionsFor(userId, keepRawToken);
  return { otherSessionsRevoked };
}

// ───────────────────────────── administration ─────────────────────────────

export interface ManagedUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  active: boolean;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  totpEnrolled: boolean;
  passwordChangedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  activeSessions: number;
}

export async function listUsers(): Promise<ManagedUser[]> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{
      id: string; email: string; full_name: string; role: string; active: boolean;
      locked_until: Date | null; failed_login_attempts: number; totp_enrolled_at: Date | null;
      password_changed_at: Date | null; last_login_at: Date | null; created_at: Date; active_sessions: string;
    }>(`SELECT u.id, u.email, u.full_name, u.role, u.active, u.locked_until, u.failed_login_attempts,
               u.totp_enrolled_at, u.password_changed_at, u.last_login_at, u.created_at,
               (SELECT count(*) FROM session s
                 WHERE s.user_id = u.id AND s.revoked_at IS NULL
                   AND s.expires_at > now() AND s.absolute_expires_at > now()) AS active_sessions
          FROM app_user u ORDER BY u.created_at`);
    return rows.map((r) => ({
      id: r.id, email: r.email, fullName: r.full_name, role: r.role, active: r.active,
      lockedUntil: r.locked_until && r.locked_until.getTime() > Date.now() ? r.locked_until.toISOString() : null,
      failedLoginAttempts: r.failed_login_attempts,
      totpEnrolled: r.totp_enrolled_at !== null,
      passwordChangedAt: r.password_changed_at?.toISOString() ?? null,
      lastLoginAt: r.last_login_at?.toISOString() ?? null,
      createdAt: r.created_at.toISOString(),
      activeSessions: Number(r.active_sessions),
    }));
  }, "admin:list-users", { quiet: true });
}

function assertRole(role: string): void {
  if (!VALID_ROLES.includes(role)) {
    throw httpError(`role must be one of: ${VALID_ROLES.join(", ")}`, 400);
  }
}

export async function createUser(input: {
  email: string; fullName?: string; role: string; password: string;
}): Promise<{ id: string }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError("A valid email is required", 400);
  assertRole(input.role);
  let hash: string;
  try {
    hash = await hashPassword(input.password);
  } catch (err) {
    throw httpError((err as Error).message, 400);
  }
  return withServiceRole(async (c) => {
    const exists = await c.query(`SELECT 1 FROM app_user WHERE lower(email) = $1`, [email]);
    if (exists.rows.length > 0) throw httpError("An account with that email already exists", 409);
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name, role, password_hash, password_changed_at)
       VALUES ($1, $2, $3, $4, now()) RETURNING id`,
      [email, (input.fullName ?? "").trim() || email.split("@")[0], input.role, hash]);
    return { id: rows[0]!.id };
  }, "admin:create-user");
}

/**
 * The "last admin" guard: no change may leave the system without an active
 * admin, and an admin cannot disable their own account (they would be locking
 * the door from the outside).
 */
async function assertAdminRemains(c: import("pg").PoolClient, targetId: string): Promise<void> {
  const { rows } = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM app_user WHERE role = 'admin' AND active AND id <> $1`, [targetId]);
  if (Number(rows[0]!.n) === 0) {
    throw httpError("This is the last active admin account — it cannot be disabled or demoted", 409);
  }
}

export async function updateUser(
  targetId: string, actorId: string,
  changes: { role?: string; fullName?: string; active?: boolean },
): Promise<{ sessionsRevoked: number }> {
  if (changes.role !== undefined) assertRole(changes.role);
  if (targetId === actorId && changes.active === false) {
    throw httpError("You cannot disable your own account", 409);
  }
  if (targetId === actorId && changes.role !== undefined && changes.role !== "admin") {
    throw httpError("You cannot remove your own admin role", 409);
  }

  const deactivated = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ role: string; active: boolean }>(
      `SELECT role, active FROM app_user WHERE id = $1`, [targetId]);
    const current = rows[0];
    if (!current) throw httpError("User not found", 404);

    const losesAdmin = current.role === "admin" && current.active
      && ((changes.role !== undefined && changes.role !== "admin") || changes.active === false);
    if (losesAdmin) await assertAdminRemains(c, targetId);

    await c.query(
      `UPDATE app_user
          SET role      = coalesce($2, role),
              full_name = coalesce($3, full_name),
              active    = coalesce($4, active)
        WHERE id = $1`,
      [targetId, changes.role ?? null, changes.fullName?.trim() || null, changes.active ?? null]);
    return current.active && changes.active === false;
  }, "admin:update-user");

  // Disabling an account ends its sessions now, not at the next idle expiry.
  const sessionsRevoked = deactivated ? await revokeAllSessionsFor(targetId) : 0;
  return { sessionsRevoked };
}

export async function unlockUser(targetId: string): Promise<void> {
  const updated = await withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE app_user SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [targetId]);
    return rowCount ?? 0;
  }, "admin:unlock-user");
  if (updated === 0) throw httpError("User not found", 404);
}

/** Admin password reset: sets the new password and ends every session. */
export async function resetUserPassword(targetId: string, newPassword: string): Promise<{ sessionsRevoked: number }> {
  let hash: string;
  try {
    hash = await hashPassword(newPassword);
  } catch (err) {
    throw httpError((err as Error).message, 400);
  }
  const updated = await withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE app_user
          SET password_hash = $2, password_changed_at = now(),
              failed_login_attempts = 0, locked_until = NULL
        WHERE id = $1`, [targetId, hash]);
    return rowCount ?? 0;
  }, "admin:reset-password");
  if (updated === 0) throw httpError("User not found", 404);
  const sessionsRevoked = await revokeAllSessionsFor(targetId);
  return { sessionsRevoked };
}

export async function userEmail(targetId: string): Promise<string | null> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ email: string }>(`SELECT email FROM app_user WHERE id = $1`, [targetId]);
    return rows[0]?.email ?? null;
  }, "admin:user-email", { quiet: true });
}
