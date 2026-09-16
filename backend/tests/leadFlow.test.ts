/**
 * GET /api/leads/flow — the top of the Overview funnel, read off the jp_job
 * mirror: leads in the range (office days), set vs not set by whether a sales
 * appointment exists, the rest bucketed by stage.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";

const reachable = await pgReachable();
requirePg(reachable);

const PASSWORD = "correct horse battery staple";
let db: TestDb;
let app: FastifyInstance;
let auth: { cookies: Record<string, string>; headers: Record<string, string> };

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}

async function job(id: string, stage: string, createdEt: string, insurance = false) {
  await db.owner.query(
    `INSERT INTO jp_job (jp_job_id, current_stage, is_insurance, jp_created_at) VALUES ($1, $2, $3, ($4::timestamp AT TIME ZONE 'America/New_York'))`,
    [id, stage, insurance, createdEt]);
}
async function appt(id: string, jobId: string, sales = true) {
  await db.owner.query(
    `INSERT INTO jp_appointment (jp_appointment_id, crm_job_id, is_sales_type, appointment_date) VALUES ($1, $2, $3, '2026-09-10')`,
    [id, jobId, sales]);
}

describe.skipIf(!reachable)("GET /api/leads/flow", () => {
  beforeAll(async () => {
    db = await createTestDb("leadflow");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    await db.owner.query(`INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4)`,
      ["rep@allied.test", "Jason Malarchak", "outside_sales_rep", await hashPassword(PASSWORD)]);
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "rep@allied.test", password: PASSWORD } });
    auth = { cookies: { allied_session: cookieFrom(res, "allied_session") }, headers: { "x-csrf-token": cookieFrom(res, "allied_csrf") } };

    // September leads.
    await job("j1", "Appointment Set", "2026-09-02 09:00");           await appt("a1", "j1");
    await job("j2", "Demo No Sale", "2026-09-05 12:00");              await appt("a2", "j2");
    await job("j3", "DQ (MGR APPROVAL)", "2026-09-06 10:00");
    await job("j4", "DQ (MGR APPROVAL)", "2026-09-07 10:00");
    await job("j5", "LEAD NOT CONTACTED!!!", "2026-09-08 10:00");
    await job("j6", "Project On Hold", "2026-09-09 10:00");
    await job("j7", "Cancel: FOLLOW UP (MGR APPR)", "2026-09-10 10:00");
    // A non-sales appointment does not make a lead "set".
    await job("j8", "CONTACTED NEEDS FOLLOW UP!!!", "2026-09-11 10:00"); await appt("a8", "j8", false);
    // Insurance: excluded like every other Overview box.
    await job("j9", "Appointment Set", "2026-09-12 10:00", true);      await appt("a9", "j9");
    // Created 11:30pm ET on Aug 31 — 03:30 UTC Sep 1. An office-calendar August lead.
    await job("j10", "DQ (MGR APPROVAL)", "2026-08-31 23:30");
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("counts September's leads on the office calendar, insurance excluded, set by sales appointment", async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30", ...auth });
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f).toMatchObject({ from: "2026-09-01", to: "2026-09-30", leads: 8, set: 2, notSet: 6, setRate: 25 });
    const by = Object.fromEntries(f.reasons.map((r: { key: string; count: number }) => [r.key, r.count]));
    expect(by).toEqual({ dq: 2, working: 2, hold: 1, cancelled: 1, dnc: 0, other: 0 });
  });

  it("puts the 11:30pm lead in August, not September", async () => {
    const aug = (await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-08-01&to=2026-08-31", ...auth })).json();
    expect(aug).toMatchObject({ leads: 1, set: 0, notSet: 1 });
    expect(aug.reasons.find((r: { key: string }) => r.key === "dq").count).toBe(1);
  });

  it("rejects bad ranges and anonymous callers", async () => {
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01", ...auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-30&to=2026-09-01", ...auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30" })).statusCode).toBe(401);
  });
});
