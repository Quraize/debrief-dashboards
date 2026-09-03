/**
 * Account and session management (self-service + admin), against the real
 * database and the real app via inject(). The properties that matter are
 * revocation properties: does a change end the sessions it should, and only
 * those?
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";

const reachable = await pgReachable();
requirePg(reachable);

const ADMIN = "admin@allied.test";
const REP = "rep@allied.test";
const PASSWORD = "correct horse battery staple";

let db: TestDb;
let app: FastifyInstance;

interface Session { cookies: Record<string, string>; headers: Record<string, string> }

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}

async function login(email: string, password = PASSWORD): Promise<Session> {
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  expect(res.statusCode, `login as ${email}`).toBe(200);
  return {
    cookies: { allied_session: cookieFrom(res, "allied_session") },
    headers: { "x-csrf-token": cookieFrom(res, "allied_csrf") },
  };
}

const me = (s: Session) => app.inject({ method: "GET", url: "/api/auth/me", ...s });

describe.skipIf(!reachable)("account management", () => {
  beforeAll(async () => {
    db = await createTestDb("acct");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.AUTH_LOGIN_RATE_MAX = "10000";
    process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;

    const hash = await hashPassword(PASSWORD);
    await db.owner.query(
      `INSERT INTO app_user (email, full_name, role, password_hash, password_changed_at) VALUES
       ($1, 'Admin', 'admin', $3, now()), ($2, 'Rep', 'outside_sales_rep', $3, now())`,
      [ADMIN, REP, hash]);

    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  describe("self-service", () => {
    it("describes the account without exposing secrets", async () => {
      const s = await login(REP);
      const res = await app.inject({ method: "GET", url: "/api/auth/account", ...s });
      expect(res.statusCode).toBe(200);
      expect(res.json().account).toMatchObject({ email: REP, role: "outside_sales_rep", totpEnrolled: false });
      expect(JSON.stringify(res.json())).not.toMatch(/password_hash|totp_secret/);
    });

    it("lists active sessions and marks the current one", async () => {
      const a = await login(REP);
      const b = await login(REP);
      const res = await app.inject({ method: "GET", url: "/api/auth/sessions", ...a });
      const sessions = res.json().sessions as { id: string; current: boolean }[];
      expect(sessions.length).toBeGreaterThanOrEqual(2);
      expect(sessions.filter((x) => x.current)).toHaveLength(1);
      expect(sessions.every((x) => /^[0-9a-f]{12}$/.test(x.id)), "ids are short prefixes, never tokens").toBe(true);
      void b;
    });

    it("revokes one specific session, leaving the others alive", async () => {
      const a = await login(REP);
      const b = await login(REP);
      const list = (await app.inject({ method: "GET", url: "/api/auth/sessions", ...a })).json().sessions;
      const other = list.find((x: { current: boolean }) => !x.current);
      const res = await app.inject({ method: "DELETE", url: `/api/auth/sessions/${other.id}`, ...a });
      expect(res.statusCode).toBe(200);
      expect((await me(a)).statusCode).toBe(200);
      // Some other session is now dead — at least one of the earlier logins.
      const alive = (await app.inject({ method: "GET", url: "/api/auth/sessions", ...a })).json().sessions;
      expect(alive.find((x: { id: string }) => x.id === other.id)).toBeUndefined();
      void b;
    });

    it("rejects a malformed session id", async () => {
      const a = await login(REP);
      expect((await app.inject({ method: "DELETE", url: "/api/auth/sessions/not-hex", ...a })).statusCode).toBe(400);
    });

    it("cannot revoke another user's session by id", async () => {
      const rep = await login(REP);
      const admin = await login(ADMIN);
      const adminList = (await app.inject({ method: "GET", url: "/api/auth/sessions", ...admin })).json().sessions;
      const res = await app.inject({ method: "DELETE", url: `/api/auth/sessions/${adminList[0].id}`, ...rep });
      expect(res.statusCode, "scoped to the caller's own sessions").toBe(404);
      expect((await me(admin)).statusCode).toBe(200);
    });

    it("signs out everywhere else, keeping the current session", async () => {
      const a = await login(REP);
      const b = await login(REP);
      const res = await app.inject({ method: "POST", url: "/api/auth/sessions/revoke-others", ...a });
      expect(res.statusCode).toBe(200);
      expect(res.json().revoked).toBeGreaterThanOrEqual(1);
      expect((await me(a)).statusCode).toBe(200);
      expect((await me(b)).statusCode).toBe(401);
    });

    it("changes the password only with the current one, then revokes other sessions", async () => {
      const a = await login(REP);
      const b = await login(REP);

      const wrong = await app.inject({ method: "POST", url: "/api/auth/password", ...a,
        payload: { current_password: "not it", new_password: "a brand new passphrase" } });
      expect(wrong.statusCode).toBe(400);
      expect(wrong.json().error).toMatch(/current password/i);

      const short = await app.inject({ method: "POST", url: "/api/auth/password", ...a,
        payload: { current_password: PASSWORD, new_password: "short" } });
      expect(short.statusCode).toBe(400);

      const ok = await app.inject({ method: "POST", url: "/api/auth/password", ...a,
        payload: { current_password: PASSWORD, new_password: "a brand new passphrase" } });
      expect(ok.statusCode).toBe(200);
      expect((await me(a)).statusCode, "the changing session survives").toBe(200);
      expect((await me(b)).statusCode, "every other session is revoked").toBe(401);

      const old = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: REP, password: PASSWORD } });
      expect(old.statusCode).toBe(401);
      await login(REP, "a brand new passphrase");

      // restore for the rest of the suite
      await app.inject({ method: "POST", url: "/api/auth/password", ...a,
        payload: { current_password: "a brand new passphrase", new_password: PASSWORD } });
    });
  });

  describe("administration", () => {
    it("is admin-only", async () => {
      const rep = await login(REP);
      expect((await app.inject({ method: "GET", url: "/api/admin/users", ...rep })).statusCode).toBe(403);
      expect((await app.inject({ method: "POST", url: "/api/admin/users", ...rep,
        payload: { email: "x@allied.test", role: "user", password: "long enough password" } })).statusCode).toBe(403);
      expect((await app.inject({ method: "GET", url: "/api/admin/users" })).statusCode).toBe(401);
    });

    it("lists users with security metadata and no secrets", async () => {
      const admin = await login(ADMIN);
      const res = await app.inject({ method: "GET", url: "/api/admin/users", ...admin });
      expect(res.statusCode).toBe(200);
      const users = res.json().users as { email: string; activeSessions: number }[];
      expect(users.map((u) => u.email).sort()).toEqual(expect.arrayContaining([ADMIN, REP]));
      expect(users.find((u) => u.email === ADMIN)!.activeSessions).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(res.json())).not.toMatch(/password_hash|totp_secret/);
    });

    it("creates an account that can sign in, and refuses duplicates and bad input", async () => {
      const admin = await login(ADMIN);
      const created = await app.inject({ method: "POST", url: "/api/admin/users", ...admin,
        payload: { email: "New.Person@allied.test", full_name: "New Person", role: "sales_manager", password: "temporary passphrase 1" } });
      expect(created.statusCode).toBe(201);
      await login("new.person@allied.test", "temporary passphrase 1");

      expect((await app.inject({ method: "POST", url: "/api/admin/users", ...admin,
        payload: { email: "new.person@allied.test", role: "user", password: "temporary passphrase 1" } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: "/api/admin/users", ...admin,
        payload: { email: "another@allied.test", role: "superuser", password: "temporary passphrase 1" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: "/api/admin/users", ...admin,
        payload: { email: "another@allied.test", role: "user", password: "short" } })).statusCode).toBe(400);

      const { rows } = await db.owner.query(`SELECT count(*)::int AS n FROM auth_event WHERE event = 'user_created'`);
      expect(rows[0]!.n).toBe(1);
    });

    it("disables an account — sessions end now, login refused — and re-enables it", async () => {
      const admin = await login(ADMIN);
      const rep = await login(REP);
      const repId = (await db.owner.query(`SELECT id FROM app_user WHERE email = $1`, [REP])).rows[0]!.id;

      const off = await app.inject({ method: "PATCH", url: `/api/admin/users/${repId}`, ...admin, payload: { active: false } });
      expect(off.statusCode).toBe(200);
      expect(off.json().sessionsRevoked).toBeGreaterThanOrEqual(1);
      expect((await me(rep)).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: REP, password: PASSWORD } })).statusCode).toBe(401);

      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${repId}`, ...admin, payload: { active: true } })).statusCode).toBe(200);
      await login(REP);
    });

    it("changes a role, but never lets an admin disable or demote themselves", async () => {
      const admin = await login(ADMIN);
      const ids = Object.fromEntries((await db.owner.query<{ email: string; id: string }>(
        `SELECT email, id FROM app_user`)).rows.map((r) => [r.email, r.id]));

      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${ids[REP]}`, ...admin,
        payload: { role: "appointment_setter" } })).statusCode).toBe(200);
      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${ids[REP]}`, ...admin,
        payload: { role: "outside_sales_rep" } })).statusCode).toBe(200);

      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${ids[ADMIN]}`, ...admin,
        payload: { active: false } })).statusCode).toBe(409);
      expect((await app.inject({ method: "PATCH", url: `/api/admin/users/${ids[ADMIN]}`, ...admin,
        payload: { role: "user" } })).statusCode).toBe(409);
      expect((await me(admin)).statusCode, "the admin is untouched").toBe(200);
    });

    it("unlocks a locked account", async () => {
      const admin = await login(ADMIN);
      const repId = (await db.owner.query(`SELECT id FROM app_user WHERE email = $1`, [REP])).rows[0]!.id;
      await db.owner.query(
        `UPDATE app_user SET failed_login_attempts = 99, locked_until = now() + interval '1 hour' WHERE id = $1`, [repId]);
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: REP, password: PASSWORD } })).statusCode).toBe(423);

      expect((await app.inject({ method: "POST", url: `/api/admin/users/${repId}/unlock`, ...admin })).statusCode).toBe(200);
      await login(REP);
    });

    it("resets a password: new one works, old sessions and old password do not", async () => {
      const admin = await login(ADMIN);
      const rep = await login(REP);
      const repId = (await db.owner.query(`SELECT id FROM app_user WHERE email = $1`, [REP])).rows[0]!.id;

      const res = await app.inject({ method: "POST", url: `/api/admin/users/${repId}/reset-password`, ...admin,
        payload: { password: "admin issued passphrase" } });
      expect(res.statusCode).toBe(200);
      expect((await me(rep)).statusCode).toBe(401);
      expect((await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: REP, password: PASSWORD } })).statusCode).toBe(401);
      await login(REP, "admin issued passphrase");

      const { rows } = await db.owner.query(`SELECT count(*)::int AS n FROM auth_event WHERE event = 'password_reset'`);
      expect(rows[0]!.n).toBe(1);
      // restore
      await app.inject({ method: "POST", url: `/api/admin/users/${repId}/reset-password`, ...admin, payload: { password: PASSWORD } });
    });

    it("signs another user out of every session", async () => {
      const admin = await login(ADMIN);
      const rep1 = await login(REP);
      const rep2 = await login(REP);
      const repId = (await db.owner.query(`SELECT id FROM app_user WHERE email = $1`, [REP])).rows[0]!.id;
      const res = await app.inject({ method: "POST", url: `/api/admin/users/${repId}/revoke-sessions`, ...admin });
      expect(res.statusCode).toBe(200);
      expect(res.json().revoked).toBeGreaterThanOrEqual(2);
      expect((await me(rep1)).statusCode).toBe(401);
      expect((await me(rep2)).statusCode).toBe(401);
      expect((await me(admin)).statusCode).toBe(200);
    });

    it("accepts the newer roles end to end — create, sign in, read data", async () => {
      // A role missing from allied_is_authenticated() would be denied every
      // table read, so this checks the DB helper too, not only the API.
      const admin = await login(ADMIN);
      for (const role of ["project_manager", "production", "inside_sales_rep"]) {
        const email = `${role}@allied.test`;
        const created = await app.inject({ method: "POST", url: "/api/admin/users", ...admin,
          payload: { email, role, password: "temporary passphrase 1" } });
        expect(created.statusCode, role).toBe(201);
        const s = await login(email, "temporary passphrase 1");
        const read = await app.inject({ method: "GET", url: "/api/entities/Appointment?limit=1", ...s });
        // `production` is production-ONLY (0013): the schedule board, never
        // sales data. The other new roles are ordinary staff.
        expect(read.statusCode, `${role} reading appointments`).toBe(role === "production" ? 403 : 200);
        const board = await app.inject({ method: "GET", url: "/api/production/board", ...s });
        expect(board.statusCode, `${role} reading the production board`).toBe(role === "inside_sales_rep" ? 403 : 200);
      }
    });

    it("still has no self-registration route", async () => {
      expect((await app.inject({ method: "POST", url: "/api/auth/register", payload: {} })).statusCode).toBe(404);
    });
  });
});
