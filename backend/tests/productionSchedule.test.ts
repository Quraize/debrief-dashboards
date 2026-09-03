/**
 * Production schedule mirror: the mapper (pure), the sync's database
 * properties (idempotent upsert, retire-and-return, address cache), and the
 * board endpoint's contract and role gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";
import { JobProgressClient } from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";
import {
  mapSchedule, parseApiTimestamp, scheduleWindow, runScheduleSync,
} from "../src/production/syncSchedules.js";
import { validateRange, jobProgressUrl } from "../src/production/board.js";

const reachable = await pgReachable();
requirePg(reachable);

// A schedule exactly as the API returned it on 2026-09-03 (names changed).
const apiSchedule = (over: Record<string, unknown> = {}) => ({
  id: 501, job_id: 7607360, customer_id: 9001,
  title: "GUTTERS: West Orange/29 Carter Rd/SR/George Golab",
  description: null,
  start_date_time: "2026-09-10 11:00:00", end_date_time: "2026-09-11 23:00:00",
  full_day: 0, is_completed: 0, is_recurring: 0, repeat: null, occurence: null, series_id: null,
  created_at: "2026-08-30 14:02:11", updated_at: "2026-09-02 09:15:40",
  job: { id: 7607360, number: "2603-6755003-02", name: "Gutters", current_stage: "Production", insurance: false },
  customer: { id: 9001, first_name: "George", last_name: "Golab" },
  sub_contractors: { data: [{ id: 55100, first_name: "Cavallari", last_name: "Gutters", email: "c@example.test" }] },
  trades: { data: [{ id: 3, name: "SIDING" }] },
  work_types: { data: [] },
  ...over,
});

describe("parseApiTimestamp", () => {
  it("reads the API's UTC wall-clock format", () => {
    expect(parseApiTimestamp("2026-09-01 11:00:00")?.toISOString()).toBe("2026-09-01T11:00:00.000Z");
    expect(parseApiTimestamp(null)).toBeNull();
    expect(parseApiTimestamp("yesterday")).toBeNull();
  });
});

describe("mapSchedule", () => {
  it("flattens job, customer and crews and parses the title code", () => {
    const row = mapSchedule(apiSchedule())!;
    expect(row).toMatchObject({
      jp_schedule_id: "501", jp_job_id: "7607360", jp_customer_id: "9001",
      job_type_code: "GUTTERS", job_number: "2603-6755003-02", customer_name: "George Golab",
      crew_ids: ["55100"], crew_names: ["Cavallari Gutters"], trades: ["SIDING"],
      is_completed: false, full_day: false,
    });
    expect(row.start_at.toISOString()).toBe("2026-09-10T11:00:00.000Z");
  });

  it("falls back to the title's customer when the include is missing, and rejects undated rows", () => {
    const row = mapSchedule(apiSchedule({ customer: null, sub_contractors: { data: [] } }))!;
    expect(row.customer_name).toBe("George Golab");
    expect(row.crew_names).toEqual([]);
    expect(mapSchedule(apiSchedule({ start_date_time: null }))).toBeNull();
  });
});

describe("scheduleWindow / validateRange", () => {
  it("looks back and ahead three weeks by default", () => {
    const w = scheduleWindow(new Date("2026-09-03T12:00:00Z"));
    expect(w).toEqual({ from: "2026-08-13", to: "2026-09-24" });
  });
  it("bounds board ranges", () => {
    expect(validateRange("2026-09-01", "2026-09-07")).toEqual({ from: "2026-09-01", to: "2026-09-07" });
    expect(validateRange("2026-09-07", "2026-09-01")).toHaveProperty("error");
    expect(validateRange("2026-09-01", "2026-12-01")).toHaveProperty("error");
    expect(validateRange("nope", "2026-09-01")).toHaveProperty("error");
  });
  it("builds the JobProgress deep link only with both ids", () => {
    expect(jobProgressUrl("9001", "7607360")).toContain("/customer-jobs/9001/job/7607360");
    expect(jobProgressUrl(null, "7607360")).toBeNull();
  });
});

// ── Database-backed ──

const PASSWORD = "correct horse battery staple";
const PRODUCTION = "prod@allied.test";
const REP = "rep@allied.test";

let db: TestDb;
let app: FastifyInstance;
const sessions = new Map<string, { cookie: string; csrf: string }>();

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}
const as = (email: string) => {
  const s = sessions.get(email)!;
  return { cookies: { allied_session: s.cookie }, headers: { "x-csrf-token": s.csrf } };
};
async function seedUser(email: string, role: string) {
  await db.owner.query(
    `INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $1, $2, $3)`,
    [email, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  sessions.set(email, { cookie: cookieFrom(res, "allied_session"), csrf: cookieFrom(res, "allied_csrf") });
}

interface Stub { schedules: Record<string, unknown>[]; addresses: Record<string, Record<string, unknown> | null>; calls: string[] }

function stubClient(stub: Stub) {
  const impl = (async (url: string) => {
    const u = String(url);
    let data: unknown = [];
    if (u.includes("/schedules")) {
      stub.calls.push("schedules");
      data = stub.schedules;
    } else if (u.includes("/jobs") && u.includes("job_ids")) {
      stub.calls.push("jobs");
      const ids = [...new URL(u).searchParams.getAll("job_ids[]")];
      data = ids.filter((id) => stub.addresses[id] !== undefined)
        .map((id) => ({ id: Number(id), address: stub.addresses[id] }));
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data, meta: { pagination: { total_pages: 1 } } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return new JobProgressClient({
    token: "test", baseUrl: "https://api.test/v3", fetchImpl: impl,
    limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });
}

const NOW = new Date("2026-09-08T12:00:00Z");
const address = { id: 1, address: "29 Carter Road", address_line_1: "", city: "West Orange",
  state: { id: 30, name: "New Jersey", code: "NJ" }, zip: "07052", lat: 40.773567, long: -74.251663 };

describe.skipIf(!reachable)("production schedule sync + board", () => {
  const stub: Stub = {
    schedules: [
      apiSchedule(),
      apiSchedule({ id: 502, job_id: 7607361, customer_id: 9002,
        title: "RR: Randolph/6 Meadow Lark Court/RR/Joseph Lorent",
        start_date_time: "2026-09-10 15:00:00", end_date_time: "2026-09-10 23:00:00",
        job: { id: 7607361, number: "2608-8992100-01", name: "Roof", insurance: false },
        customer: { id: 9002, first_name: "Joseph", last_name: "Lorent" },
        sub_contractors: { data: [] }, trades: { data: [] } }),
    ],
    addresses: { "7607360": address, "7607361": { ...address, id: 2, address: "6 Meadow Lark Court", city: "Randolph", lat: null, long: null } },
    calls: [],
  };

  beforeAll(async () => {
    db = await createTestDb("production");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000";
    process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    delete process.env.LEAP_API_TOKEN;
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    await seedUser(PRODUCTION, "production");
    await seedUser(REP, "outside_sales_rep");
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("mirrors schedules and caches job addresses on the first run", async () => {
    const result = await runScheduleSync({ client: stubClient(stub), now: NOW, startedBy: "test" });
    expect(result.status).toBe("completed");
    expect(result.counts).toMatchObject({
      schedules_examined: 2, schedules_created: 2, schedules_updated: 0, schedules_retired: 0,
      locations_fetched: 2, locations_without_coordinates: 1,
    });
    const { rows } = await db.owner.query(`SELECT jp_schedule_id, crew_names, job_type_code, deleted_at FROM jp_schedule ORDER BY jp_schedule_id`);
    expect(rows).toEqual([
      { jp_schedule_id: "501", crew_names: ["Cavallari Gutters"], job_type_code: "GUTTERS", deleted_at: null },
      { jp_schedule_id: "502", crew_names: [], job_type_code: "RR", deleted_at: null },
    ]);
    const run = await db.owner.query(`SELECT kind, status FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(run.rows[0]).toEqual({ kind: "schedules", status: "completed" });
  });

  it("is idempotent, and does not refetch fresh addresses", async () => {
    stub.calls.length = 0;
    const result = await runScheduleSync({ client: stubClient(stub), now: NOW, startedBy: "test" });
    expect(result.counts).toMatchObject({ schedules_created: 0, schedules_updated: 2, locations_fetched: 0 });
    expect(stub.calls).toEqual(["schedules"]);
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM jp_schedule`)).rows[0].n).toBe(2);
  });

  it("retires a schedule that vanished from JobProgress and revives it if it returns", async () => {
    const removed = stub.schedules.pop()!;
    let result = await runScheduleSync({ client: stubClient(stub), now: NOW, startedBy: "test" });
    expect(result.counts.schedules_retired).toBe(1);
    let row = (await db.owner.query(`SELECT deleted_at FROM jp_schedule WHERE jp_schedule_id = '502'`)).rows[0];
    expect(row.deleted_at).not.toBeNull();

    stub.schedules.push(removed);
    result = await runScheduleSync({ client: stubClient(stub), now: NOW, startedBy: "test" });
    expect(result.counts.schedules_retired).toBe(0);
    row = (await db.owner.query(`SELECT deleted_at FROM jp_schedule WHERE jp_schedule_id = '502'`)).rows[0];
    expect(row.deleted_at).toBeNull();
  });

  it("records a failed run instead of throwing when the API is down", async () => {
    const broken = new JobProgressClient({
      token: "test", baseUrl: "https://api.test/v3",
      fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
      limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }),
      sleep: async () => {},
    });
    const result = await runScheduleSync({ client: broken, now: NOW, startedBy: "test" });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/ECONNRESET/);
    const run = await db.owner.query(`SELECT status FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(run.rows[0].status).toBe("failed");
    // The mirror is untouched by a failed run.
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM jp_schedule WHERE deleted_at IS NULL`)).rows[0].n).toBe(2);
  });

  it("serves the board for a day, in New York time, with status and coordinates", async () => {
    // 11:00Z → 07:00 New York on the 10th; the gutters job runs into the 11th.
    const res = await app.inject({ method: "GET", url: "/api/production/board?date=2026-09-10", ...as(PRODUCTION) });
    expect(res.statusCode).toBe(200);
    const board = res.json();
    expect(board.timezone).toBe("America/New_York");
    expect(board.items).toHaveLength(2);
    const gutters = board.items.find((i: { jpScheduleId: string }) => i.jpScheduleId === "501");
    expect(gutters).toMatchObject({
      status: "assigned", startDay: "2026-09-10", endDay: "2026-09-11", startTime: "07:00", multiDay: true,
      parsed: { code: "GUTTERS", town: "West Orange" },
      crews: [{ id: "55100", name: "Cavallari Gutters" }],
      location: { city: "West Orange", lat: 40.773567, lng: -74.251663 },
    });
    expect(gutters.jpUrl).toContain("/customer-jobs/9001/job/7607360");
    const roof = board.items.find((i: { jpScheduleId: string }) => i.jpScheduleId === "502");
    expect(roof.status).toBe("unassigned");
    expect(roof.location.lat).toBeNull();
    expect(board.crews).toEqual([{ id: "55100", name: "Cavallari Gutters" }]);
    expect(board.sync?.status).toBe("failed"); // the most recent run above
    // The multi-day job is still on the board the next day; the one-day job is not.
    const next = (await app.inject({ method: "GET", url: "/api/production/board?date=2026-09-11", ...as(PRODUCTION) })).json();
    expect(next.items.map((i: { jpScheduleId: string }) => i.jpScheduleId)).toEqual(["501"]);
  });

  it("supports a bounded range and rejects bad input", async () => {
    const ok = await app.inject({ method: "GET", url: "/api/production/board?from=2026-09-07&to=2026-09-13", ...as(PRODUCTION) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/production/board?date=10-09-2026", ...as(PRODUCTION) })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/production/board?from=2026-01-01&to=2026-12-31", ...as(PRODUCTION) })).statusCode).toBe(400);
  });

  it("is closed to sales reps and to anonymous callers", async () => {
    expect((await app.inject({ method: "GET", url: "/api/production/board?date=2026-09-10", ...as(REP) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/production/board?date=2026-09-10" })).statusCode).toBe(401);
    // The generic entity API honours the same policy (registry + RLS).
    expect((await app.inject({ method: "GET", url: "/api/entities/JPSchedule", ...as(REP) })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/entities/JPSchedule", ...as(PRODUCTION) })).statusCode).toBe(200);
  });

  it("refuses a manual refresh while the integration is unconfigured", async () => {
    const res = await app.inject({ method: "POST", url: "/api/production/sync", ...as(PRODUCTION) });
    expect(res.statusCode).toBe(501);
  });
});
