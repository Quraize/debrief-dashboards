/**
 * GET /api/production/revenue — the Revenue & AR summary off the jp_job
 * mirror and its payments, management only.
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
type Auth = { cookies: Record<string, string>; headers: Record<string, string> };
let pm: Auth, crew: Auth;

function cookieFrom(res: { headers: Record<string, unknown> }, name: string): string {
  const raw = res.headers["set-cookie"];
  const all = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  return all.find((c) => c.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1) ?? "";
}
async function login(email: string, role: string): Promise<Auth> {
  await db.owner.query(`INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $1, $2, $3)`, [email, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  return { cookies: { allied_session: cookieFrom(res, "allied_session") }, headers: { "x-csrf-token": cookieFrom(res, "allied_csrf") } };
}
async function job(id: string, stage: string, signed: string, contract: number | null, received: number | null, owed: number | null, completion: string | null = null) {
  await db.owner.query(
    `INSERT INTO jp_job (jp_job_id, jp_customer_id, job_number, current_stage, is_insurance, jp_created_at, contract_signed_date,
                         total_job_revenue, total_payment_received, total_amount_owed, completion_date, rep_names)
     VALUES ($1, '9001', $2, $3, false, now() - interval '60 days', $4::date, $5, $6, $7, $8::date, 'Matt Steussing')`,
    [id, `2609-${id}-01`, stage, signed, contract, received, owed, completion]);
}
async function visit(id: string, jobId: string, dayEt: string) {
  await db.owner.query(
    `INSERT INTO jp_schedule (jp_schedule_id, jp_job_id, title, job_type_code, start_at, end_at, crew_names)
     VALUES ($1, $2, 'RR', 'RR', ($3::timestamp AT TIME ZONE 'America/New_York'), ($3::timestamp AT TIME ZONE 'America/New_York') + interval '8 hours', '{DNC}')`,
    [id, jobId, `${dayEt} 08:00`]);
}
async function payment(id: string, jobId: string, day: string, amount: number, canceled = false) {
  await db.owner.query(
    `INSERT INTO jp_job_payment (jp_payment_id, jp_job_id, amount, method, method_label, payment_date, status, canceled)
     VALUES ($1, $2, $3, 'cheque', 'Check', $4::date, 'paid', $5)`, [id, jobId, amount, day, canceled]);
}

const today = new Date();
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(today.getTime() - n * 86_400_000));

describe.skipIf(!reachable)("Revenue & AR", () => {
  beforeAll(async () => {
    db = await createTestDb("revenue");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    process.env.AR_OVERDUE_DAYS = "30";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    pm = await login("pm@allied.test", "project_manager");
    crew = await login("crew@allied.test", "production");
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name) VALUES ('9001','Maureen Bondy')`);

    // In production, started yesterday, deposit taken.
    await job("a", "Production Started", daysAgo(20), 20000, 5000, 15000); await visit("sa", "a", daysAgo(1)); await payment("pa", "a", daysAgo(20), 5000);
    // Completed 10 days ago, still owing: AR, not yet overdue.
    await job("b", "COMPLETED NEED FINAL PAYMENT!!", daysAgo(50), 12000, 8000, 4000, daysAgo(10)); await visit("sb", "b", daysAgo(15)); await payment("pb", "b", daysAgo(50), 8000);
    // Completed 45 days ago, owing: overdue AR. No calendar history at all — the stage carries it.
    await job("c", "COMPLETED NEED FINAL PAYMENT!!", daysAgo(120), 1000, 0, 1000, daysAgo(45));
    // Paid stage with a balance the ledger still shows.
    await job("d", "Paid New Roof", daysAgo(90), 40000, 37000, 3000); await visit("sd", "d", daysAgo(60)); await payment("pd", "d", daysAgo(90), 37000);
    // In production with nothing received — and a cancelled payment that must not count.
    await job("e", "Gutters/Solar/Punchlist", daysAgo(30), 15500, 0, 15500); await visit("se", "e", daysAgo(5)); await payment("pe", "e", daysAgo(30), 2000, true);
    // Booked, not started: not in this view.
    await job("f", "Approved New Installs", daysAgo(3), 9000, 900, 8100); await visit("sf", "f", iso(new Date(today.getTime() + 10 * 86_400_000)));
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("adds up started revenue, paid, owed, AR and overdue from the mirror and its payments", async () => {
    const res = await app.inject({ method: "GET", url: "/api/production/revenue", ...pm });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    const by = Object.fromEntries(p.rows.map((r: { jobId: string }) => [r.jobId, r]));
    expect(Object.keys(by).sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(by["a"]).toMatchObject({ status: "inProduction", customer: "Maureen Bondy", deposit: 5000, received: 5000, owed: 15000, noPayment: false, startedDay: daysAgo(1) });
    expect(by["b"]).toMatchObject({ status: "completed", daysOutstanding: 10, overdue: false, completedDay: daysAgo(10) });
    expect(by["c"]).toMatchObject({ status: "completed", daysOutstanding: 45, overdue: true, startedDay: null, noPayment: true });
    expect(by["d"]).toMatchObject({ status: "paid", paidInFull: true, paidStageOwed: true, owed: 3000 });
    expect(by["e"]).toMatchObject({ status: "inProduction", noPayment: true, deposit: null, paymentsCount: 0 });
    expect(p.totals).toMatchObject({
      overdueDays: 30, jobs: 5,
      paidInFull: 40000, paidInFullJobs: 1,
      remainingOwed: 15000 + 4000 + 1000 + 3000 + 15500, remainingOwedJobs: 5,
      totalAR: 5000, totalARJobs: 2, overdueAR: 1000, overdueARJobs: 1,
      flags: { noPayment: 2, paidStageOwed: 1, paidStageOwedAmount: 3000, noContractValue: 0, noLedger: 0 },
    });
    // Started this week includes job a (yesterday) unless yesterday fell in last week.
    expect(p.totals.startedThisWeek + p.totals.startedMonthToDate).toBeGreaterThan(0);
    expect(p.rows[0].jpUrl).toContain("/job/");
  });

  it("is management's: production and anonymous callers are refused", async () => {
    expect((await app.inject({ method: "GET", url: "/api/production/revenue", ...crew })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/production/revenue" })).statusCode).toBe(401);
  });
});
