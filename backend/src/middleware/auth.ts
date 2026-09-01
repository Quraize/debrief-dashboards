/**
 * Request authentication, CSRF, and role authorization.
 *
 * This is layer one of the two described in MIGRATION_PLAN.md §5.2-5.3. It
 * establishes who is asking; RLS in PostgreSQL independently enforces what they
 * may touch, so a handler that forgets a check still fails closed.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { resolveSession, type SessionUser } from "../auth/session.js";
import { hashToken, safeEqual } from "../auth/crypto.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: SessionUser;
    sessionToken?: string;
  }
}

const isProd = process.env.NODE_ENV === "production";

/**
 * The __Host- prefix is the strongest cookie binding the platform offers: the
 * browser refuses it unless it is Secure, Path=/, and has no Domain attribute,
 * which makes it impossible for a subdomain to set or overwrite. It requires
 * HTTPS, so plain-http local development falls back to the bare name.
 */
export const SESSION_COOKIE = isProd ? "__Host-allied_session" : "allied_session";
export const CSRF_COOKIE = isProd ? "__Host-allied_csrf" : "allied_csrf";
export const CSRF_HEADER = "x-csrf-token";

export function sessionCookieOptions(expires: Date) {
  return {
    httpOnly: true,        // unreadable from JavaScript, so XSS cannot exfiltrate it
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

/**
 * The CSRF cookie is deliberately NOT httpOnly - the frontend has to read it to
 * echo it back in a header. That is safe because knowing this value proves
 * nothing on its own: an attacker's site cannot read cookies cross-origin, and
 * the session cookie it would need alongside remains unreadable.
 */
export function csrfCookieOptions(expires: Date) {
  return {
    httpOnly: false,
    secure: isProd,
    sameSite: "lax" as const,
    path: "/",
    expires,
  };
}

export function clearCookieOptions() {
  return { httpOnly: true, secure: isProd, sameSite: "lax" as const, path: "/", expires: new Date(0) };
}

/**
 * Populates request.user when a valid session cookie is present.
 * Never rejects - it only establishes identity. Enforcement is requireAuth's job,
 * which keeps "who is this" and "may they" as separate, testable decisions.
 */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const raw = req.cookies?.[SESSION_COOKIE];
  if (!raw) return;
  const resolved = await resolveSession(raw);
  if (!resolved) return;
  req.user = resolved.user;
  req.sessionToken = raw;
}

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: "Authentication required" });
  }
}

/**
 * Role gate. Under D11 the single account is `admin`, so every check passes
 * today - it exists because it is the seam multi-user onboarding plugs into,
 * and adding it later means auditing every route instead of one middleware.
 */
export function requireRole(...roles: string[]) {
  return async function roleGuard(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!req.user) {
      await reply.code(401).send({ error: "Authentication required" });
      return;
    }
    if (!roles.includes(req.user.role)) {
      // 403, not 404: the caller is authenticated and this is not a secret URL.
      await reply.code(403).send({ error: "Insufficient permissions" });
    }
  };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Double-submit CSRF.
 *
 * SameSite=Lax already blocks cross-site POST cookies in every current browser,
 * so this is defence in depth rather than the only barrier - which is the right
 * posture for a control whose failure mode is silent.
 *
 * The header value is compared against the hash bound to THIS session, so a
 * token minted for another session is rejected.
 */
export async function requireCsrf(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (SAFE_METHODS.has(req.method)) return;
  if (!req.user || !req.sessionToken) return; // unauthenticated: requireAuth handles it

  const header = req.headers[CSRF_HEADER];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided) {
    await reply.code(403).send({ error: "Missing CSRF token" });
    return;
  }

  const resolved = await resolveSession(req.sessionToken);
  if (!resolved || !safeEqual(hashToken(provided), resolved.csrfTokenHash)) {
    await reply.code(403).send({ error: "Invalid CSRF token" });
  }
}

/** Registers authentication for every route on the instance. */
export function registerAuthHooks(app: FastifyInstance): void {
  app.addHook("preHandler", authenticate);
}

/** Trusts the reverse proxy for the client IP; Caddy sets X-Forwarded-For. */
export function clientIp(req: FastifyRequest): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd?.split(",")[0];
  return (first ?? req.ip)?.trim();
}

export const userAgent = (req: FastifyRequest): string | undefined => {
  const ua = req.headers["user-agent"];
  return Array.isArray(ua) ? ua[0] : ua;
};
