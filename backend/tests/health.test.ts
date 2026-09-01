/**
 * Application boot and health.
 *
 * buildApp() now reads column metadata from the database at startup, so it
 * genuinely requires one. That is deliberate: a backend whose schema does not
 * match its registry should refuse to start rather than serve requests that
 * fail one at a time later.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

let db: TestDb;
let app: FastifyInstance;

describe.skipIf(!reachable)("application boot", () => {
  beforeAll(async () => {
    db = await createTestDb("health");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;

    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("serves health without authentication", async () => {
    // Deliberately unauthenticated: a health check that needs a session cannot
    // tell a load balancer whether the process is alive.
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "ok" });
  });

  it("reveals nothing useful in the health payload", async () => {
    const body = JSON.stringify((await app.inject({ method: "GET", url: "/api/health" })).json());
    expect(body).not.toMatch(/postgres:\/\/|password|token|secret/i);
  });

  it("refuses to boot against a database missing its schema", async () => {
    // The registry maps entities to tables; if a table is gone, that is a
    // deployment error worth failing loudly at startup rather than per request.
    const empty = await createTestDb("health_empty");
    try {
      await empty.owner.query("DROP TABLE IF EXISTS appointment CASCADE");
      const { loadColumns } = await import("../src/entities/registry.js");
      const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
      const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
      const { closePools } = await import("../src/db/client.js");
      await closePools();
      process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${empty.name}`;

      await expect(loadColumns()).rejects.toThrow(/missing table/i);
    } finally {
      const { closePools } = await import("../src/db/client.js");
      await closePools();
      await empty.drop();
      // Restore the pools this file's other tests rely on.
      const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
      const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
      process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
      process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    }
  });
});
