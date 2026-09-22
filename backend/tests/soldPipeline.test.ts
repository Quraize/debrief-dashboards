/**
 * GET /api/production/pipeline and the Blocker / Owner / Next Action note —
 * the Sold-Job Pipeline read off the jp_job mirror under a production user.
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
let prod: Auth, rep: Auth;

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
async function job(id: string, number: string, stage: string, signed: string | null, revenue: number | null, customer = "9001") {
  await db.owner.query(
    `INSERT INTO jp_job (jp_job_id, jp_customer_id, job_number, current_stage, is_insurance, jp_created_at, contract_signed_date, total_job_revenue, rep_names)
     VALUES ($1, $2, $3, $4, false, now() - interval '30 days', $5::date, $6, 'Jason Malarchak')`,
    [id, customer, number, stage, signed, revenue]);
}
async function visit(id: string, jobId: string, code: string, dayEt: string) {
  await db.owner.query(
    `INSERT INTO jp_schedule (jp_schedule_id, jp_job_id, title, job_type_code, start_at, end_at, crew_names)
     VALUES ($1, $2, $3, $3, ($4::timestamp AT TIME ZONE 'America/New_York'), ($4::timestamp AT TIME ZONE 'America/New_York') + interval '6 hours', '{DNC}')`,
    [id, jobId, code, `${dayEt} 08:00`]);
}

describe.skipIf(!reachable)("Sold-Job Pipeline", () => {
  beforeAll(async () => {
    db = await createTestDb("pipeline");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    prod = await login("prod@allied.test", "production");
    rep = await login("rep@allied.test", "outside_sales_rep");
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name) VALUES ('9001','Lisa Diss'), ('9002','Rolito Guinto')`);

    // Unscheduled: sold, awaiting the sold-sheet handoff. The CEO's real backlog.
    await job("j1", "2609-0001-01", "Install Accepted-> SUBMIT SS", "2026-09-16", 26749);
    // Scheduled by the calendar: a roof install (RR) booked; a site assessment before it is not an install.
    await job("j2", "2609-0002-01", "Approved New Installs", "2026-09-01", 58899, "9002");
    await visit("s2a", "j2", "MSSA", "2026-09-05"); await visit("s2b", "j2", "RR", "2026-10-06");
    // Scheduled by the stage: a repair whose visit code the install list does not know.
    await job("j3", "2609-0003-01", "Repairs Scheduled", "2026-09-10", 3350);
    await visit("s3", "j3", "REPAIR", "2026-10-02");
    // Completed, awaiting payment: still pipeline (not cash), not production's queue.
    await job("j4", "2608-0004-01", "COMPLETED NEED FINAL PAYMENT!!", "2026-08-01", 12000);
    // Left the pipeline: paid.
    await job("j5", "2607-0005-01", "Paid New Roof", "2026-07-01", 40000);
    // Never pipeline: cancelled, and a DQ that somehow carries a signed date.
    await job("j6", "2607-0006-01", "Cancel: FOLLOW UP (MGR APPR)", "2026-07-02", 9000);
    await job("j7", "2603-0007-01", "Disqualified Lead", "2026-03-09", null);
    // No contract value on a live insurance-pending job: counted, and flagged.
    await job("j8", "2607-0008-01", "Accepted/INS Claim Pending", "2026-07-09", null);
    // Not sold at all.
    await job("j9", "2609-0009-01", "Appointment Set", null, null);
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("buckets every sold, unpaid job and adds up the CEO's totals", async () => {
    const res = await app.inject({ method: "GET", url: "/api/production/pipeline", ...prod });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.totals).toMatchObject({
      jobs: 5, totalPipeline: 26749 + 58899 + 3350 + 12000,
      unscheduled: 26749, unscheduledJobs: 2, awaitingProduction: 2,      // j1 and the no-value j8
      scheduled: 58899 + 3350, scheduledJobs: 2,
      inProduction: 0, awaitingPayment: 12000, awaitingPaymentJobs: 1,
      noContractValue: 1,
    });
    const by = Object.fromEntries(p.rows.map((r: { jobId: string }) => [r.jobId, r]));
    expect(by["j1"]).toMatchObject({ customer: "Lisa Diss", bucket: "unscheduled", blocker: "Awaiting sold-sheet handoff to production", blockerDerived: true, rep: "Jason Malarchak", scheduledDate: null });
    expect(by["j2"]).toMatchObject({ customer: "Rolito Guinto", bucket: "scheduled", scheduledDate: "2026-10-06", expectedWeek: "2026-10-05", blocker: "Scheduled" });
    expect(by["j3"]).toMatchObject({ bucket: "scheduled", scheduledDate: null, blocker: "Scheduled" });   // the stage carried it
    expect(by["j4"]).toMatchObject({ bucket: "awaitingPayment", blocker: "Awaiting final payment" });
    expect(by["j8"]).toMatchObject({ bucket: "unscheduled", noContractValue: true, blocker: "Insurance claim pending" });
    for (const gone of ["j5", "j6", "j7", "j9"]) expect(by[gone], gone).toBeUndefined();
    // Oldest sale first.
    expect(p.rows.map((r: { jobId: string }) => r.jobId)).toEqual(["j8", "j4", "j2", "j3", "j1"]);
    expect(p.rows[0].jpUrl).toContain("/job/j8/");
  });

  it("lets production write Blocker, Owner and Next Action, stamped, and a blank blocker falls back to the stage", async () => {
    const save = await app.inject({ method: "POST", url: "/api/production/pipeline/j1/note", ...prod,
      payload: { blocker: "Sold sheet missing the color selection", owner: "Pema", nextAction: "Rep to send color by Friday" } });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({ jobId: "j1", blocker: "Sold sheet missing the color selection", owner: "Pema", nextAction: "Rep to send color by Friday", updatedBy: "prod@allied.test" });
    let row = (await app.inject({ method: "GET", url: "/api/production/pipeline", ...prod })).json().rows.find((r: { jobId: string }) => r.jobId === "j1");
    expect(row).toMatchObject({ blocker: "Sold sheet missing the color selection", blockerDerived: false, owner: "Pema", noteUpdatedBy: "prod@allied.test" });
    // Clearing the blocker hands it back to the stage; owner stays.
    await app.inject({ method: "POST", url: "/api/production/pipeline/j1/note", ...prod, payload: { blocker: "", owner: "Pema", nextAction: "" } });
    row = (await app.inject({ method: "GET", url: "/api/production/pipeline", ...prod })).json().rows.find((r: { jobId: string }) => r.jobId === "j1");
    expect(row).toMatchObject({ blocker: "Awaiting sold-sheet handoff to production", blockerDerived: true, owner: "Pema", nextAction: null });
  });

  it("is production's: a sales rep and an anonymous caller are refused", async () => {
    expect((await app.inject({ method: "GET", url: "/api/production/pipeline", ...rep })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/production/pipeline/j1/note", ...rep, payload: { owner: "me" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/production/pipeline" })).statusCode).toBe(401);
  });
});
