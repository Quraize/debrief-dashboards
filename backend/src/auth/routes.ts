/**
 * Authentication routes.
 *
 * There is deliberately NO registration route here (D11). Not disabled, not
 * gated behind a role - absent. A route that does not exist cannot be
 * misconfigured back into existence, and tests/auth.test.ts asserts it 404s.
 *
 * Password reset is likewise absent for now: with one shared account, a reset
 * flow is a larger attack surface than the problem it solves. Rotation is an
 * operational task (scripts/seed-user.ts), not a self-service one.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPassword } from "./crypto.js";
import { createSession, revokeSession, revokeAllSessionsFor, ABSOLUTE_TTL_MS } from "./session.js";
import {
  findAccountByEmail, isLocked, registerFailure, registerSuccess, recordAuthEvent,
  totpRequired, verifyTotpForLogin, beginTotpEnrollment, completeTotpEnrollment,
  MAX_FAILED_ATTEMPTS,
} from "./account.js";
import {
  SESSION_COOKIE, CSRF_COOKIE, sessionCookieOptions, csrfCookieOptions, clearCookieOptions,
  requireAuth, requireCsrf, clientIp, userAgent,
} from "../middleware/auth.js";

interface LoginBody { email?: string; password?: string; totp?: string }

/**
 * One message for every credential failure.
 *
 * Distinguishing "no such account" from "wrong password" from "wrong TOTP"
 * hands an attacker a free oracle. The audit trail records the real reason;
 * the client is told only that it failed.
 */
const GENERIC_FAILURE = "Invalid email or password";

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: LoginBody }>("/api/auth/login", {
    config: {
      // Per-IP throttle in front of the per-account lockout. The two cover
      // different attacks: this one slows a spray across many accounts, the
      // lockout stops a focused guess at one.
      // Configurable so tests can exercise both the normal path and the limiter
      // itself; production leaves it at the default.
      rateLimit: { max: Number(process.env.AUTH_LOGIN_RATE_MAX ?? 10), timeWindow: "1 minute" },
    },
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", minLength: 3, maxLength: 320 },
          password: { type: "string", minLength: 1, maxLength: 1024 },
          totp: { type: "string", minLength: 6, maxLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const ctx = { ip: clientIp(req), userAgent: userAgent(req) };
    const email = (req.body.email ?? "").trim();
    const password = req.body.password ?? "";

    const account = await findAccountByEmail(email);

    // Always run the password verification, even with no account, so the
    // response time does not reveal whether the address exists.
    const passwordOk = await verifyPassword(account?.password_hash ?? null, password);

    if (!account) {
      await recordAuthEvent("login_failed", false, email, ctx, "no such account");
      return reply.code(401).send({ error: GENERIC_FAILURE });
    }
    if (!account.active) {
      await recordAuthEvent("login_failed", false, email, ctx, "account inactive");
      return reply.code(401).send({ error: GENERIC_FAILURE });
    }
    if (isLocked(account)) {
      await recordAuthEvent("locked_out", false, email, ctx, "attempt while locked");
      // The lockout IS disclosed, unlike other failures: the user needs to know
      // why waiting will help, and an attacker who triggered it already knows.
      return reply.code(423).send({
        error: "Account temporarily locked after repeated failed attempts. Try again later.",
      });
    }
    if (!passwordOk) {
      const { locked, attempts } = await registerFailure(account.id);
      await recordAuthEvent(locked ? "locked_out" : "login_failed", false, email, ctx,
        `bad password (${attempts}/${MAX_FAILED_ATTEMPTS})`);
      return reply.code(401).send({ error: GENERIC_FAILURE });
    }

    if (totpRequired(account)) {
      const code = (req.body.totp ?? "").trim();
      if (!code) {
        // Password was correct but a second factor is needed. Signalled with a
        // distinct flag so the UI can show the code field, without ever being
        // reachable before the password check passes.
        return reply.code(401).send({ error: "Authentication code required", totpRequired: true });
      }
      if (!await verifyTotpForLogin(account, code)) {
        const { locked, attempts } = await registerFailure(account.id);
        await recordAuthEvent(locked ? "locked_out" : "totp_failed", false, email, ctx,
          `bad or reused code (${attempts}/${MAX_FAILED_ATTEMPTS})`);
        return reply.code(401).send({ error: GENERIC_FAILURE });
      }
    }

    // New session on every login: never adopt a token the client arrived with,
    // which is what makes session fixation impossible.
    const session = await createSession(account.id, ctx);
    await registerSuccess(account.id);
    await recordAuthEvent("login", true, email, ctx, totpRequired(account) ? "password + totp" : "password");

    const csrfExpiry = new Date(Date.now() + ABSOLUTE_TTL_MS);
    return reply
      .setCookie(SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt))
      .setCookie(CSRF_COOKIE, session.csrfToken, csrfCookieOptions(csrfExpiry))
      .send({
        user: { email: account.email, fullName: account.full_name, role: account.role },
        csrfToken: session.csrfToken,
        expiresAt: session.expiresAt.toISOString(),
      });
  });

  app.post("/api/auth/logout", { preHandler: [requireAuth, requireCsrf] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.sessionToken) await revokeSession(req.sessionToken);
      await recordAuthEvent("logout", true, req.user?.email ?? null,
        { ip: clientIp(req), userAgent: userAgent(req) });
      return reply
        .setCookie(SESSION_COOKIE, "", clearCookieOptions())
        .setCookie(CSRF_COOKIE, "", clearCookieOptions())
        .send({ ok: true });
    });

  // Replaces base44.auth.me(). Returns 401 rather than an empty user, so the
  // frontend cannot mistake "logged out" for "loaded with no data".
  app.get("/api/auth/me", { preHandler: requireAuth }, async (req: FastifyRequest, reply: FastifyReply) =>
    reply.send({
      user: { email: req.user!.email, fullName: req.user!.fullName, role: req.user!.role },
    }));

  // ── TOTP enrollment ──
  // Two steps on purpose: the secret is only persisted once a code proves the
  // authenticator actually holds it. Enrolling on generate is how an account
  // ends up locked out by a QR nobody finished scanning.

  app.post("/api/auth/totp/begin", { preHandler: [requireAuth, requireCsrf] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const enrollment = await beginTotpEnrollment(req.user!.email);
      return reply.send({
        secret: enrollment.secret,
        otpauthUri: enrollment.otpauthUri,
        qrDataUri: enrollment.qrDataUri,
        note: "Scan this, then confirm with a code. It is not active until confirmed.",
      });
    });

  app.post<{ Body: { secret: string; code: string } }>("/api/auth/totp/confirm", {
    preHandler: [requireAuth, requireCsrf],
    schema: {
      body: {
        type: "object",
        required: ["secret", "code"],
        properties: {
          secret: { type: "string", minLength: 16, maxLength: 64 },
          code: { type: "string", minLength: 6, maxLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const ctx = { ip: clientIp(req), userAgent: userAgent(req) };
    const ok = await completeTotpEnrollment(req.user!.id, req.user!.email, req.body.secret, req.body.code);
    if (!ok) {
      await recordAuthEvent("totp_failed", false, req.user!.email, ctx, "enrollment code rejected");
      return reply.code(400).send({ error: "That code is not valid. Check your device clock and try again." });
    }
    await recordAuthEvent("totp_enrolled", true, req.user!.email, ctx);

    // Enrolling a second factor invalidates every OTHER session: if one was
    // stolen, this is the moment it stops being useful. The session doing the
    // enrolling survives - it just proved possession of the new factor.
    const revoked = await revokeAllSessionsFor(req.user!.id, req.sessionToken);
    return reply.send({ ok: true, otherSessionsRevoked: revoked });
  });
}
