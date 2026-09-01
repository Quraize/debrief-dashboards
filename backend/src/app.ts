import Fastify, { type FastifyInstance, type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { registerAuthRoutes } from "./auth/routes.js";
import { registerEntityRoutes } from "./entities/routes.js";
import { registerFileRoutes } from "./files/routes.js";
import { registerFunctionRoutes } from "./functions/routes.js";
import { loadColumns } from "./entities/registry.js";
import { registerAuthHooks } from "./middleware/auth.js";

/**
 * Builds the Fastify instance without starting it, so tests can exercise
 * routes via `app.inject()` with no port binding or teardown races.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // Request ids make the structured logs in MIGRATION_PLAN.md §10.6 traceable.
    genReqId: () => crypto.randomUUID(),
    // Caddy terminates TLS and sets X-Forwarded-*; without this every client
    // looks like 127.0.0.1 and per-IP rate limiting becomes a global limit.
    trustProxy: true,
    bodyLimit: 1_048_576, // 1 MiB; file uploads get their own route later
  });

  await app.register(cookie);

  // Spreadsheet uploads for the appointment import. The per-file ceiling is
  // enforced again inside the route, because multipart truncates rather than
  // throwing and a partial file must never be treated as a complete one.
  await app.register(multipart, {
    limits: {
      fileSize: Number(process.env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024),
      files: 1,
    },
  });

  // Global backstop. Individual routes tighten this - /api/auth/login is 10/min.
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_GLOBAL_MAX ?? 300),
    timeWindow: "1 minute",
    // Fail open on limiter errors rather than locking everyone out.
    skipOnError: true,
  });

  // Security headers. Deliberately hand-rolled rather than pulling in helmet:
  // the app is served same-origin behind Caddy (§10.1), so this is a short,
  // explicit list rather than a framework's defaults we would have to audit.
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    // API responses are never cacheable: they are per-session by definition.
    reply.header("Cache-Control", "no-store");
    return payload;
  });

  registerAuthHooks(app);

  app.get("/api/health", async () => ({
    status: "ok",
    service: "allied-sales-sync-backend",
    time: new Date().toISOString(),
  }));

  registerAuthRoutes(app);

  // Column metadata is read from information_schema once at boot. Every
  // identifier the entity API puts into SQL originates from that catalog, so a
  // client string can only be compared against it, never interpolated.
  await loadColumns();
  registerEntityRoutes(app);
  registerFileRoutes(app);
  registerFunctionRoutes(app);

  // Never leak internals to the client; the detail goes to the log instead.
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) console.error(`[${req.id}] ${req.method} ${req.url}`, err);
    reply.code(status).send({
      error: status >= 500 ? "Internal server error" : err.message,
      requestId: req.id,
    });
  });

  return app;
}
