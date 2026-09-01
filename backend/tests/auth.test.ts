/**
 * Authentication security tests (MIGRATION_PLAN.md §8.3).
 *
 * Under D11 there is one shared credential, which makes these MORE important,
 * not less: there is no second account to fall back on and no per-person
 * revocation, so every control here is load-bearing.
 *
 * Runs against a real database and the real Fastify app via inject().
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import * as OTPAuth from "otpauth";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword, generateToken, hashToken, safeEqual } from "../src/auth/crypto.js";
import { MAX_FAILED_ATTEMPTS } from "../src/auth/account.js";

const reachable = await pgReachable();
requirePg(reachable);

const EMAIL = "ops@allied.test";
const PASSWORD = "correct horse battery staple";

let db: TestDb;
let app: FastifyInstance;

/** Extracts a Set-Cookie value by name from an inject() response. */
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const hit = all.find((c) => c.startsWith(`${name}=`));
  return hit?.split(";")[0]?.slice(name.length + 1);
}
function cookieAttrs(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`)) ?? "";
}

async function login(totp?: string) {
  return app.inject({
    method: "POST", url: "/api/auth/login",
    payload: { email: EMAIL, password: PASSWORD, ...(totp ? { totp } : {}) },
  });
}

describe.skipIf(!reachable)("authentication", () => {
  beforeAll(async () => {
    db = await createTestDb("auth");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    // The suite logs in dozens of times; the production limiter would throttle
    // it. Raised here and exercised deliberately in its own test below.
    process.env.AUTH_LOGIN_RATE_MAX = "10000";
    process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    // The auth layer uses the jobs pool exclusively (migration 0005).
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;

    await db.owner.query(
      `INSERT INTO app_user (email, full_name, role, password_hash, password_changed_at)
       VALUES ($1, 'Allied Ops', 'admin', $2, now())`,
      [EMAIL, await hashPassword(PASSWORD)],
    );

    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  describe("password hashing", () => {
    it("uses argon2id, not argon2i or argon2d", async () => {
      // The algorithm is not passed explicitly (see crypto.ts); this asserts the
      // library default really is what we depend on, rather than assuming it.
      const h = await hashPassword("a-sufficiently-long-password");
      expect(h.startsWith("$argon2id$")).toBe(true);
    });

    it("pins the cost parameters in the hash string", async () => {
      const h = await hashPassword("a-sufficiently-long-password");
      expect(h).toContain("m=19456,t=2,p=1");
    });

    it("refuses short passwords at the hashing boundary", async () => {
      await expect(hashPassword("short")).rejects.toThrow(/at least 12/i);
    });

    it("produces a different hash for the same password (salted)", async () => {
      const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
      expect(a).not.toBe(b);
    });
  });

  describe("token handling", () => {
    it("never stores a raw session token", async () => {
      const res = await login();
      const raw = cookieFrom(res, "allied_session")!;
      const { rows } = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM session WHERE token_hash = $1`, [raw]);
      expect(rows[0]!.n, "the raw token must not appear in the database").toBe(0);
      const { rows: hashed } = await db.owner.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM session WHERE token_hash = $1`, [hashToken(raw)]);
      expect(hashed[0]!.n).toBe(1);
    });

    it("generates high-entropy, non-repeating tokens", () => {
      const seen = new Set(Array.from({ length: 200 }, generateToken));
      expect(seen.size).toBe(200);
      expect([...seen][0]!.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
    });

    it("compares secrets without leaking length", () => {
      expect(safeEqual("abc", "abc")).toBe(true);
      expect(safeEqual("abc", "abcd")).toBe(false);
      expect(safeEqual("", "")).toBe(true);
    });
  });

  describe("login", () => {
    it("succeeds with the right credentials", async () => {
      const res = await login();
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: EMAIL, role: "admin" });
    });

    it("sets an httpOnly, SameSite=Lax session cookie", async () => {
      const attrs = cookieAttrs(await login(), "allied_session");
      expect(attrs).toMatch(/HttpOnly/i);
      expect(attrs).toMatch(/SameSite=Lax/i);
      expect(attrs).toMatch(/Path=\//);
    });

    it("makes the CSRF cookie readable by JavaScript, unlike the session cookie", async () => {
      // Intentional: the client must echo it in a header. Knowing it proves
      // nothing without the session cookie, which stays unreadable.
      expect(cookieAttrs(await login(), "allied_csrf")).not.toMatch(/HttpOnly/i);
    });

    it("issues a brand-new session on every login (no fixation)", async () => {
      const a = cookieFrom(await login(), "allied_session");
      const b = cookieFrom(await login(), "allied_session");
      expect(a).not.toBe(b);
    });

    it("gives the same message for a wrong password and an unknown account", async () => {
      const wrongPw = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: EMAIL, password: "definitely not the password" },
      });
      const noSuchUser = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: "nobody@allied.test", password: "definitely not the password" },
      });
      expect(wrongPw.statusCode).toBe(401);
      expect(noSuchUser.statusCode).toBe(401);
      // Identical responses: no user-enumeration oracle.
      expect(wrongPw.json().error).toBe(noSuchUser.json().error);
    });

    it("rejects a malformed body before touching the database", async () => {
      const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL } });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("session", () => {
    it("returns the user for /me when authenticated", async () => {
      const token = cookieFrom(await login(), "allied_session")!;
      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe(EMAIL);
    });

    it("refuses /me with no cookie", async () => {
      expect((await app.inject({ method: "GET", url: "/api/auth/me" })).statusCode).toBe(401);
    });

    it("refuses a forged token", async () => {
      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: generateToken() },
      });
      expect(res.statusCode).toBe(401);
    });

    it("refuses a revoked session", async () => {
      const res = await login();
      const token = cookieFrom(res, "allied_session")!;
      const csrf = cookieFrom(res, "allied_csrf")!;
      await app.inject({
        method: "POST", url: "/api/auth/logout",
        cookies: { allied_session: token }, headers: { "x-csrf-token": csrf },
      });
      const after = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(after.statusCode).toBe(401);
    });

    it("refuses an expired session", async () => {
      const token = cookieFrom(await login(), "allied_session")!;
      await db.owner.query(
        `UPDATE session SET expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [hashToken(token)]);
      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(401);
    });

    it("refuses a session whose absolute expiry has passed", async () => {
      const token = cookieFrom(await login(), "allied_session")!;
      // Both fields move together: the table's CHECK forbids an absolute
      // deadline earlier than the idle one, and in reality they converge -
      // sliding clamps expires_at to absolute_expires_at (see the next test).
      await db.owner.query(
        `UPDATE session
            SET expires_at          = now() - interval '1 second',
                absolute_expires_at = now() - interval '1 second'
          WHERE token_hash = $1`, [hashToken(token)]);
      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(401);
    });

    it("never slides the idle window past the absolute deadline", async () => {
      // This is what actually stops a continuously-active session living
      // forever: every use extends expires_at, but only up to the wall fixed
      // at login. Without the clamp, an attacker with a stolen cookie could
      // keep it alive indefinitely just by using it.
      const token = cookieFrom(await login(), "allied_session")!;
      // Both fields set coherently - the CHECK forbids an absolute deadline
      // earlier than the idle one, so a near-term wall means a nearer idle.
      await db.owner.query(
        `UPDATE session
            SET expires_at          = now() + interval '10 seconds',
                absolute_expires_at = now() + interval '30 seconds'
          WHERE token_hash = $1`, [hashToken(token)]);

      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(200);

      const { rows } = await db.owner.query<{ within: boolean }>(
        `SELECT expires_at <= absolute_expires_at AS within
           FROM session WHERE token_hash = $1`, [hashToken(token)]);
      expect(rows[0]!.within, "idle expiry must be clamped to the absolute deadline").toBe(true);
    });

    it("cuts off a deactivated account immediately", async () => {
      const token = cookieFrom(await login(), "allied_session")!;
      await db.owner.query(`UPDATE app_user SET active = false WHERE email = $1`, [EMAIL]);
      const res = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(401);
      await db.owner.query(`UPDATE app_user SET active = true WHERE email = $1`, [EMAIL]);
    });
  });

  describe("CSRF", () => {
    it("refuses a state-changing request with no CSRF header", async () => {
      const token = cookieFrom(await login(), "allied_session")!;
      const res = await app.inject({
        method: "POST", url: "/api/auth/logout", cookies: { allied_session: token },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toMatch(/csrf/i);
    });

    it("refuses a CSRF token minted for a different session", async () => {
      const a = await login();
      const b = await login();
      const res = await app.inject({
        method: "POST", url: "/api/auth/logout",
        cookies: { allied_session: cookieFrom(a, "allied_session")! },
        headers: { "x-csrf-token": cookieFrom(b, "allied_csrf")! },
      });
      expect(res.statusCode).toBe(403);
    });

    it("accepts the matching CSRF token", async () => {
      const res = await login();
      const out = await app.inject({
        method: "POST", url: "/api/auth/logout",
        cookies: { allied_session: cookieFrom(res, "allied_session")! },
        headers: { "x-csrf-token": cookieFrom(res, "allied_csrf")! },
      });
      expect(out.statusCode).toBe(200);
    });
  });

  describe("lockout", () => {
    it("locks the account after repeated failures, then refuses even the right password", async () => {
      const email = "lockme@allied.test";
      await db.owner.query(
        `INSERT INTO app_user (email, full_name, role, password_hash)
         VALUES ($1,'Lock Me','admin',$2)`, [email, await hashPassword(PASSWORD)]);

      for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
        const r = await app.inject({
          method: "POST", url: "/api/auth/login", payload: { email, password: "wrong-password-here" },
        });
        expect(r.statusCode).toBe(401);
      }
      // The right password now fails too - that is the point of a lockout.
      const locked = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD },
      });
      expect(locked.statusCode).toBe(423);
      expect(locked.json().error).toMatch(/locked/i);
    }, 30_000);

    it("records failures in the audit trail without storing the attempted password", async () => {
      const { rows } = await db.owner.query<{ event: string; detail: string }>(
        `SELECT event, detail FROM auth_event WHERE NOT succeeded ORDER BY id DESC LIMIT 20`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        expect(r.detail ?? "").not.toContain("wrong-password-here");
        expect(r.detail ?? "").not.toContain(PASSWORD);
      }
    });

    it("clears the failure counter on a successful login", async () => {
      await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: EMAIL, password: "nope-not-it" } });
      await login();
      const { rows } = await db.owner.query<{ failed_login_attempts: number }>(
        `SELECT failed_login_attempts FROM app_user WHERE email = $1`, [EMAIL]);
      expect(rows[0]!.failed_login_attempts).toBe(0);
    });
  });

  describe("TOTP", () => {
    const totpEmail = "totp@allied.test";
    let sessionCookie: string;
    let csrf: string;
    let secret: string;

    beforeAll(async () => {
      await db.owner.query(
        `INSERT INTO app_user (email, full_name, role, password_hash)
         VALUES ($1,'TOTP User','admin',$2)`, [totpEmail, await hashPassword(PASSWORD)]);
      const res = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email: totpEmail, password: PASSWORD },
      });
      sessionCookie = cookieFrom(res, "allied_session")!;
      csrf = cookieFrom(res, "allied_csrf")!;
    });

    const code = (s: string, offsetSteps = 0) =>
      new OTPAuth.TOTP({
        issuer: "Allied Sales Sync", label: totpEmail, algorithm: "SHA1",
        digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(s),
      }).generate({ timestamp: Date.now() + offsetSteps * 30_000 });

    it("does not activate the secret until a code confirms it", async () => {
      const begin = await app.inject({
        method: "POST", url: "/api/auth/totp/begin",
        cookies: { allied_session: sessionCookie }, headers: { "x-csrf-token": csrf },
      });
      expect(begin.statusCode).toBe(200);
      secret = begin.json().secret;
      expect(begin.json().qrDataUri).toMatch(/^data:image\/png;base64,/);

      // Nothing persisted yet: an abandoned enrollment must not lock the account.
      const { rows } = await db.owner.query<{ totp_secret: string | null }>(
        `SELECT totp_secret FROM app_user WHERE email = $1`, [totpEmail]);
      expect(rows[0]!.totp_secret).toBeNull();
    });

    it("rejects a wrong confirmation code", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/auth/totp/confirm",
        cookies: { allied_session: sessionCookie }, headers: { "x-csrf-token": csrf },
        payload: { secret, code: "000000" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("activates on a valid code", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/auth/totp/confirm",
        cookies: { allied_session: sessionCookie }, headers: { "x-csrf-token": csrf },
        payload: { secret, code: code(secret) },
      });
      expect(res.statusCode).toBe(200);
    });

    it("keeps the enrolling session alive", async () => {
      // Revoking every session here would log the user out of the tab they just
      // enrolled from, having proved possession of the new factor a moment ago.
      const me = await app.inject({
        method: "GET", url: "/api/auth/me", cookies: { allied_session: sessionCookie },
      });
      expect(me.statusCode).toBe(200);
    });

    it("now demands a code at login", async () => {
      const res = await app.inject({
        method: "POST", url: "/api/auth/login", payload: { email: totpEmail, password: PASSWORD },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().totpRequired).toBe(true);
    });

    it("accepts a valid code", async () => {
      // A step ahead of the one consumed by enrollment: that code was legitimately
      // burned when it proved possession, so reusing it here would be a replay -
      // and is correctly refused.
      const res = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: totpEmail, password: PASSWORD, totp: code(secret, 1) },
      });
      expect(res.statusCode).toBe(200);
    });

    it("refuses to reuse the code consumed during enrollment", async () => {
      // Enrollment burned the current step, so the same code cannot then be
      // used to log in - the guard treats enrollment and login as one sequence.
      const res = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: totpEmail, password: PASSWORD, totp: code(secret) },
      });
      expect(res.statusCode).toBe(401);
    });

    it("refuses to accept the same code twice (replay)", async () => {
      // A TOTP code stays valid for its whole 30s step, so without a replay
      // guard a code captured by a proxy or over a shoulder can be reused
      // inside that window.
      //
      // The guard is reset first so this tests the replay rule in isolation
      // rather than whatever step earlier tests happened to consume. Stepping
      // further into the future is not an option: window=1 tolerates only one
      // step of clock skew, by design.
      await db.owner.query(
        `UPDATE app_user SET totp_last_step = NULL WHERE email = $1`, [totpEmail]);

      const c = code(secret);
      const first = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: totpEmail, password: PASSWORD, totp: c },
      });
      expect(first.statusCode, "first use of a fresh code should succeed").toBe(200);

      const replay = await app.inject({
        method: "POST", url: "/api/auth/login",
        payload: { email: totpEmail, password: PASSWORD, totp: c },
      });
      expect(replay.statusCode, "the same code must not work twice").toBe(401);
    });
  });

  describe("rate limiting", () => {
    it("throttles repeated login attempts from one IP", async () => {
      // Built with a deliberately low limit: the per-IP throttle sits in front
      // of the per-account lockout and covers a different attack - a spray
      // across many accounts, which never trips any single account's counter.
      process.env.AUTH_LOGIN_RATE_MAX = "3";
      const { buildApp } = await import("../src/app.js");
      const limited = await buildApp();
      try {
        const codes: number[] = [];
        for (let i = 0; i < 6; i++) {
          const r = await limited.inject({
            method: "POST", url: "/api/auth/login",
            payload: { email: "spray@allied.test", password: "guessing-at-passwords" },
          });
          codes.push(r.statusCode);
        }
        expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
      } finally {
        await limited.close();
        process.env.AUTH_LOGIN_RATE_MAX = "10000";
      }
    }, 30_000);
  });

  describe("no registration surface exists", () => {
    it.each([
      ["POST", "/api/auth/register"],
      ["POST", "/api/register"],
      ["POST", "/api/signup"],
      ["POST", "/api/auth/signup"],
      ["POST", "/api/auth/password-reset"],
      ["POST", "/api/auth/forgot-password"],
    ])("%s %s does not exist", async (method, url) => {
      const res = await app.inject({ method: method as "POST", url, payload: {} });
      // 404, not 401/403: the route is absent, not merely guarded (D11).
      expect(res.statusCode).toBe(404);
    });
  });

  describe("response hardening", () => {
    it("sets the expected security headers", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["cache-control"]).toBe("no-store");
    });

    it("never returns a password hash or token to the client", async () => {
      const res = await login();
      const body = JSON.stringify(res.json());
      expect(body).not.toContain("$argon2");
      expect(body).not.toContain("password");
    });
  });
});
