/**
 * Jobs by stage: the sweep's database properties (stage list mirrored, tracked
 * jobs upserted with their stage, jobs that moved to an untracked stage
 * re-read and released) and the board endpoint's contract and role gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";
import { JobProgressClient } from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";
import { runJobStageSync } from "../src/production/syncJobStages.js";

const reachable = await pgReachable();
requirePg(reachable);

const STAGES = [
  { id: 1, code: "S-PROD-START", name: "Production Started", position: 30, color: "cl-blue", locked: 0, jobs_count: 9 },
  { id: 2, code: "S-COMPLETE", name: "COMPLETED NEED FINAL PAYMENT!!", position: 40, color: "cl-red", locked: 0, jobs_count: 13 },
  { id: 3, code: "S-PAID", name: "Paid New Roof", position: 50, color: "cl-skyblue", locked: 0, jobs_count: 8 },
  { id: 4, code: "S-LEAD", name: "LEAD NOT CONTACTED!!!", position: 1, color: "cl-red", locked: 1, jobs_count: 345 },
];
const job = (id: number, stage: typeof STAGES[number], over: Record<string, unknown> = {}) => ({
  id, customer_id: 9000 + id, number: `2609-${id}-01`, name: "Roof", division_id: 1, insurance: false,
  current_stage: { name: stage.name, code: stage.code, color: stage.color }, stage_last_modified: "2026-08-20 10:00:00",
  awarded_date: "2026-08-01", contract_signed_date: "2026-08-01",
  address: { address: `${id} Main St`, city: "Wayne", state: { code: "NJ" }, zip: "07470", lat: 40.9, long: -74.2 },
  ...over,
});

interface Stub { stages: Record<string, unknown>[]; inStages: Record<string, unknown>[]; byId: Record<string, Record<string, unknown>>; calls: string[] }
function stubClient(stub: Stub) {
  const impl = (async (url: string) => {
    const u = String(url);
    let data: unknown = [];
    if (u.includes("/workflow/stages")) { stub.calls.push("stages"); data = stub.stages; }
    else if (u.includes("/divisions")) { data = [{ id: 1, name: "ACR Roofing Division" }]; }
    else if (u.includes("job_ids")) {
      stub.calls.push("by-ids");
      const ids = new URL(u).searchParams.getAll("job_ids[]");
      data = ids.map((id) => stub.byId[id]).filter(Boolean);
    } else if (u.includes("stages%5B%5D") || u.includes("stages[]")) { stub.calls.push("in-stages"); data = stub.inStages; }
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data, meta: { pagination: { total_pages: 1 } } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return new JobProgressClient({
    token: "test", baseUrl: "https://api.test/v3", fetchImpl: impl,
    limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }), sleep: async () => {},
  });
}

const PASSWORD = "correct horse battery staple";
let db: TestDb;
let app: FastifyInstance;
const sessions = new Map<string, { cookie: string; csrf: string }>();
function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}
const as = (email: string) => ({ cookies: { allied_session: sessions.get(email)!.cookie }, headers: { "x-csrf-token": sessions.get(email)!.csrf } });
async function seedUser(email: string, role: string) {
  await db.owner.query(`INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $1, $2, $3)`, [email, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  sessions.set(email, { cookie: cookieFrom(res, "allied_session"), csrf: cookieFrom(res, "allied_csrf") });
}

describe.skipIf(!reachable)("jobs by stage", () => {
  const stub: Stub = { stages: STAGES, inStages: [job(1, STAGES[0]!), job(2, STAGES[1]!)], byId: {}, calls: [] };

  beforeAll(async () => {
    db = await createTestDb("stages");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    await seedUser("prod@allied.test", "production");
    await seedUser("rep@allied.test", "outside_sales_rep");
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name) VALUES ('9001','George Golab'), ('9002','Joseph Lorent')`);
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("mirrors the stage list and the jobs in tracked stages, with locations", async () => {
    const r = await runJobStageSync({ client: stubClient(stub), startedBy: "test" });
    expect(r.status).toBe("completed");
    expect(r.counts).toMatchObject({ stages_examined: 4, stages_tracked: 2, jobs_examined: 2, jobs_upserted: 2, jobs_moved_out: 0, locations_fetched: 2 });
    const stages = await db.owner.query(`SELECT code, name, jobs_count FROM jp_workflow_stage ORDER BY position`);
    expect(stages.rows.map((s) => s.code)).toEqual(["S-LEAD", "S-PROD-START", "S-COMPLETE", "S-PAID"]);
    const jobs = await db.owner.query(`SELECT jp_job_id, current_stage, stage_code, jp_customer_id, division, stage_seen_at IS NOT NULL AS tracked FROM jp_job ORDER BY jp_job_id`);
    expect(jobs.rows).toEqual([
      { jp_job_id: "1", current_stage: "Production Started", stage_code: "S-PROD-START", jp_customer_id: "9001", division: "ACR Roofing Division", tracked: true },
      { jp_job_id: "2", current_stage: "COMPLETED NEED FINAL PAYMENT!!", stage_code: "S-COMPLETE", jp_customer_id: "9002", division: "ACR Roofing Division", tracked: true },
    ]);
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM jp_job_location`)).rows[0].n).toBe(2);
  });

  it("serves the board grouped like the Jobs screen, with days in stage and customer names", async () => {
    const res = await app.inject({ method: "GET", url: "/api/production/jobs", ...as("prod@allied.test") });
    expect(res.statusCode).toBe(200);
    const board = res.json();
    expect(board.groups.map((g: { label: string; count: number }) => [g.label, g.count])).toEqual([["Project Won", 0], ["Production", 2], ["Warranty Work", 0]]);
    const production = board.groups[1];
    expect(production.stages.map((s: { name: string; count: number; jobsCount: number }) => [s.name, s.count, s.jobsCount]))
      .toEqual([["Production Started", 1, 9], ["COMPLETED NEED FINAL PAYMENT!!", 1, 13]]);
    expect(board.items).toHaveLength(2);
    expect(board.items[0]).toMatchObject({ jobId: "1", customerName: "George Golab", stageGroup: "production", location: { city: "Wayne", lat: 40.9 } });
    expect(board.items[0].daysInStage).toBeGreaterThan(10);
    expect(board.items[0].jpUrl).toContain("/customer-jobs/9001/job/1");
  });

  it("re-reads jobs that left the tracked stages and drops them from the board", async () => {
    stub.inStages = [job(1, STAGES[0]!)];                 // job 2 no longer returned by the stage query…
    stub.byId["2"] = job(2, STAGES[2]!);                   // …because it was paid
    stub.calls.length = 0;
    const r = await runJobStageSync({ client: stubClient(stub), startedBy: "test" });
    expect(r.counts).toMatchObject({ jobs_examined: 1, jobs_moved_out: 1 });
    expect(stub.calls).toContain("by-ids");
    const moved = (await db.owner.query(`SELECT current_stage, stage_seen_at FROM jp_job WHERE jp_job_id = '2'`)).rows[0];
    expect(moved.current_stage).toBe("Paid New Roof");
    expect(moved.stage_seen_at).toBeNull();
    const board = (await app.inject({ method: "GET", url: "/api/production/jobs", ...as("prod@allied.test") })).json();
    expect(board.items.map((i: { jobId: string }) => i.jobId)).toEqual(["1"]);
  });

  it("is closed to sales reps", async () => {
    expect((await app.inject({ method: "GET", url: "/api/production/jobs", ...as("rep@allied.test") })).statusCode).toBe(403);
  });
});
