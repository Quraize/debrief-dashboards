/**
 * GET /api/leads/flow — the Overview funnel followed lead by lead, read off
 * the jp_job mirror plus each lead's debriefs.
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

async function job(id: string, number: string | null, stage: string, createdEt: string, insurance = false) {
  await db.owner.query(
    `INSERT INTO jp_job (jp_job_id, job_number, current_stage, is_insurance, jp_created_at) VALUES ($1, $2, $3, $4, ($5::timestamp AT TIME ZONE 'America/New_York'))`,
    [id, number, stage, insurance, createdEt]);
}
async function appt(id: string, jobId: string, sales = true, date = "2026-09-10") {
  await db.owner.query(
    `INSERT INTO jp_appointment (jp_appointment_id, crm_job_id, is_sales_type, appointment_date) VALUES ($1, $2, $3, $4::date)`,
    [id, jobId, sales, date]);
}
async function debrief(leadId: string, outcome: string, over: Record<string, unknown> = {}) {
  await db.owner.query(
    `INSERT INTO debrief (submitted_by, customer_name, appointment_date, sales_rep, appointment_setter, appointment_type, appointment_outcome,
                          crm_lead_id, crm_job_id, sale_amount, approval_status, created_by, sale_signed_date)
     VALUES ('rep@allied.test', $1, $8::date, 'Jason Malarchak', 'Ashley Pascual', $2, $3, $4, $5, $6, $7, 'rep@allied.test', $9::date)`,
    [`Customer ${leadId}`, over["appointment_type"] ?? "First Appointment", outcome, over["crm_lead_id"] ?? leadId,
      over["crm_job_id"] ?? null, over["sale_amount"] ?? null, over["approval_status"] ?? null, over["appointment_date"] ?? "2026-09-10",
      over["sale_signed_date"] ?? null]);
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

    // September leads, followed through their appointments.
    await job("j1", "2609-0001-01", "Demo No Sale", "2026-09-02 09:00");           await appt("a1", "j1");
    await debrief("2609-0001-01", "Demo Completed — Sale", { sale_amount: 20000 });
    await job("j2", "2609-0002-01", "Demo No Sale", "2026-09-03 09:00");           await appt("a2", "j2");
    await debrief("2609-0002-01", "Demo Completed — Demo No Sale");
    await job("j3", "2609-0003-01", "No Demo: RESET APPOINTMENT", "2026-09-04 09:00"); await appt("a3", "j3");
    await debrief("2609-0003-01", "No Demo — Reset Needed");
    // Matched on the CRM job id rather than the typed Lead ID; a reset visit that then demoed.
    await job("j4", "2609-0004-01", "Job Lost DNS (MGR APPROVAL)", "2026-09-05 09:00"); await appt("a4", "j4");
    await debrief("typo-lead", "No C / No Show — Reset Needed", { crm_job_id: "j4" });
    await debrief("typo-lead", "Demo Completed — Demo No Sale", { crm_job_id: "j4", appointment_type: "Reset Demo" });
    await job("j5", "2609-0005-01", "Job Lost No See (Mgr Approval)", "2026-09-06 09:00"); await appt("a5", "j5");
    await debrief("2609-0005-01", "No C / No Show — Do Not Reset");
    await job("j6", "2609-0006-01", "Appointment Set", "2026-09-07 09:00");          await appt("a6", "j6"); // booked, nothing yet
    // A DQ debrief awaiting a manager is not a result yet.
    await job("j7", "2609-0007-01", "Appointment Set", "2026-09-07 10:00");          await appt("a7", "j7");
    await debrief("2609-0007-01", "No Demo — DQ / Do Not Reset", { approval_status: "pending" });
    // Not set, by reason.
    await job("j8", "2609-0008-01", "DQ (MGR APPROVAL)", "2026-09-08 10:00");
    await job("j9", "2609-0009-01", "DQ (MGR APPROVAL)", "2026-09-08 11:00");
    await job("j10", "2609-0010-01", "LEAD NOT CONTACTED!!!", "2026-09-09 10:00");
    await job("j11", "2609-0011-01", "Est In Progress(MGR APPROVAL)", "2026-09-09 11:00");
    await job("j12", "2609-0012-01", "Project On Hold", "2026-09-10 10:00");
    await job("j13", "2609-0013-01", "Cancel: FOLLOW UP (MGR APPR)", "2026-09-11 10:00");
    // A non-sales appointment does not make a lead "set".
    await job("j14", "2609-0014-01", "CONTACTED NEEDS FOLLOW UP!!!", "2026-09-11 11:00"); await appt("a14", "j14", false);
    // Excluded: insurance, and a warranty callback that is not a lead.
    await job("j15", "2609-0015-01", "Appointment Set", "2026-09-12 10:00", true);  await appt("a15", "j15");
    await job("j16", "2609-0016-01", "Open Warranty Claims/CallBacks", "2026-09-12 11:00");
    // Created 11:30pm ET on Aug 31 — 03:30 UTC Sep 1. An office-calendar August lead.
    await job("j17", "2608-0017-01", "DQ (MGR APPROVAL)", "2026-08-31 23:30");
    // An AUGUST lead that demoed and sold in September: the work the cohort
    // question cannot see. Its August visit stays in August.
    await job("j18", "2608-0018-01", "Demo No Sale", "2026-08-12 10:00");
    await appt("a18a", "j18", true, "2026-08-20"); await appt("a18b", "j18", true, "2026-09-18");
    await debrief("2608-0018-01", "No C / No Show — Reset Needed", { appointment_date: "2026-08-20" });
    await debrief("2608-0018-01", "Demo Completed — Sale", { sale_amount: 31000, appointment_date: "2026-09-18", appointment_type: "Reset Demo" });
    // A September lead whose visit is booked for October: set in cohort, not
    // yet work done in September, and never "Not Set" — it IS booked.
    await job("j19", "2609-0019-01", "Appointment Set", "2026-09-20 10:00"); await appt("a19", "j19", true, "2026-10-05");
    // Ruben Sanchez's shape: a June demo the rep closed by phone in September.
    // June's demo, September's money.
    await job("j20", "2606-0020-01", "Demo No Sale", "2026-06-20 10:00"); await appt("a20", "j20", true, "2026-06-27");
    await debrief("2606-0020-01", "Demo Completed — Sale", { sale_amount: 14399, appointment_date: "2026-06-27", sale_signed_date: "2026-09-09" });
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("follows September's leads through their appointments, every column summing to its parent", async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30&basis=cohort", ...auth });
    expect(res.statusCode).toBe(200);
    const f = res.json();
    expect(f).toMatchObject({
      from: "2026-09-01", to: "2026-09-30", basis: "cohort",
      leads: 15, valid: 13, disqualified: 2, set: 8, notSet: 5,   // j19 arrived in September and is booked
      ran: 4, noSee: 1, awaiting: 3,          // j6 and j19 booked; j7's DQ still awaiting approval
      demo: 3, noDemo: 1, pending: 0,
      sold: 1, notSold: 2, revenue: 20000,    // the August lead's $31,000 is not September's cohort
      setFromEarlier: 0, setRate: 62,
    });
    expect(f.valid + f.disqualified).toBe(f.leads);
    expect(f.set + f.notSet).toBe(f.valid);
    expect(f.ran + f.noSee + f.awaiting).toBe(f.set);
    expect(f.demo + f.noDemo + f.pending).toBe(f.ran);
    const by = Object.fromEntries(f.reasons.map((r: { key: string; count: number }) => [r.key, r.count]));
    expect(by).toEqual({ working: 3, hold: 1, cancelled: 1, dnc: 0, other: 0 });
  });

  it("counts the work done in September by default: the August lead's demo in, October's booking out", async () => {
    const res = await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30", ...auth });
    const f = res.json();
    expect(f).toMatchObject({
      basis: "activity",
      leads: 15, valid: 13, disqualified: 2, notSet: 5,   // the lead columns do not move
      set: 8, setFromEarlier: 1, setRate: null, byVisit: true,
      appointments: 8,                                    // visits dated in September, resets included
      // Counted as VISITS off the Sales dashboard's own populations: j4 was a
      // no-show and then a reset demo, which is two visits, not one lead, and
      // j7's DQ counts as an appointment and a no-demo there whether or not a
      // manager has approved it yet.
      ran: 6, noSee: 2, awaiting: 0,
      demo: 4, noDemo: 2, pending: 0,
      // The Sold card reports the Sales dashboard's Sales and Revenue: every
      // sale SIGNED in September — the two demos above plus Ruben's June demo,
      // closed by phone on 9 September. His visit is June's, his sale is
      // September's, so Sold (3) exceeds the demos here that sold (2).
      sold: 3, demoSold: 2, notSold: 1, revenue: 65399, demoRevenue: 51000,
    });
    expect(f.ran + f.noSee + f.awaiting).toBe(f.set);
    expect(f.demo + f.noDemo + f.pending).toBe(f.ran);
  });

  it("leaves June its demo and gives September the money, and never overrides the cohort question", async () => {
    // June: Ruben's visit and his demo, but the Sold card shows no money — he
    // signed in September, so that is where the Sales dashboard puts it.
    const jun = (await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-06-01&to=2026-06-30", ...auth })).json();
    // The demo sold, but not in June: Sold and its money are both zero here.
    expect(jun).toMatchObject({ basis: "activity", byVisit: true, set: 1, demo: 1, sold: 0, demoSold: 1, demoRevenue: 14399, revenue: 0 });
    // Cohort is a different question and keeps its own money: September's own
    // leads sold 20,000, whatever was signed in September from earlier demos.
    const coh = (await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30&basis=cohort", ...auth })).json();
    expect(coh).toMatchObject({ basis: "cohort", revenue: 20000, demoRevenue: 20000 });
  });

  it("gives the August lead its August visit, and nothing of September", async () => {
    const aug = (await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-08-01&to=2026-08-31", ...auth })).json();
    // j17 (DQ, 11:30pm) and j18 arrived in August; only j18's no-show visit falls in it.
    expect(aug).toMatchObject({ basis: "activity", leads: 2, disqualified: 1, valid: 1, set: 1, noSee: 1, ran: 0, sold: 0, revenue: 0, appointments: 1 });
    expect(aug.ran + aug.noSee + aug.awaiting).toBe(aug.set);
  });

  it("puts the 11:30pm lead in August, not September", async () => {
    const aug = (await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-08-01&to=2026-08-31&basis=cohort", ...auth })).json();
    expect(aug).toMatchObject({ leads: 2, disqualified: 1, valid: 1, set: 1, notSet: 0 });
  });

  it("rejects bad ranges and anonymous callers", async () => {
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01", ...auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-30&to=2026-09-01", ...auth })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/leads/flow?from=2026-09-01&to=2026-09-30" })).statusCode).toBe(401);
  });
});
