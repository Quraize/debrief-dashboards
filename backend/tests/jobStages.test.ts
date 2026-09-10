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

interface Stub {
  stages: Record<string, unknown>[]; inStages: Record<string, unknown>[]; byId: Record<string, Record<string, unknown>>;
  summaries: Record<string, Record<string, unknown>>; payments: Record<string, Record<string, unknown>[]>;
  bills: Record<string, Record<string, unknown>[]>; calls: string[];
}
const PAYMENT_TYPES = [
  { id: 122, label: "Cash", method: "cash" }, { id: 123, label: "Check", method: "echeque" }, { id: 124, label: "Credit Card", method: "cc" },
];
function stubClient(stub: Stub) {
  const impl = (async (url: string) => {
    const u = String(url);
    let data: unknown = [];
    if (u.includes("/workflow/stages")) { stub.calls.push("stages"); data = stub.stages; }
    else if (u.includes("/company/payment_types")) { stub.calls.push("payment-types"); data = PAYMENT_TYPES; }
    else if (u.includes("/payment_history")) {
      const id = /jobs\/(\d+)\/payment_history/.exec(u)![1]!;
      stub.calls.push(`payments:${id}`);
      data = stub.payments[id] ?? [];
    }
    else if (u.includes("/vendor_bills")) {
      const id = /jobs\/(\d+)\/vendor_bills/.exec(u)![1]!;
      stub.calls.push(`bills:${id}`);
      data = stub.bills[id] ?? [];
    }
    else if (u.includes("/divisions")) { data = [{ id: 1, name: "ACR Roofing Division" }]; }
    else if (u.includes("/financial_summary")) {
      const id = /jobs\/(\d+)\/financial_summary/.exec(u)![1]!;
      stub.calls.push(`summary:${id}`);
      data = stub.summaries[id] ? [stub.summaries[id]] : [];
    }
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

// Job 1 arrives with everything the Weekly Job Sheet needs on the listing
// itself (rep, sub, complete financial_details). Job 2 carries none of it, so
// its money must come from the per-job financial summary.
const SHEET_JOB_1 = {
  reps: { data: [{ id: 501, first_name: "Jason", last_name: "Malarchak" }] },
  sub_contractors: { data: [{ id: 601, first_name: "Lucy", last_name: "", company_name: "Lucy Construction" }] },
  financial_details: { data: { total_job_price: 13999, total_change_order_amount: 0, total_job_revenue: 13999, total_payment_received: 2276, total_amount_owed: 11723 } },
  completion_date: "2026-09-02 15:00:00",
};

describe.skipIf(!reachable)("jobs by stage", () => {
  const stub: Stub = {
    stages: STAGES, inStages: [job(1, STAGES[0]!, SHEET_JOB_1), job(2, STAGES[1]!)], byId: {}, calls: [],
    summaries: { "2": { total_job_price: 4552, total_change_order_amount: "150.50", total_payment_received: 2276, total_amount_owed: 2426.5 } },
    // Shaped like the API's record_payment response. Job 1: a cash deposit, a
    // check, and a canceled duplicate. Job 2: one card payment.
    payments: {
      "1": [
        { id: 7001, customer_id: 9001, job_id: 1, canceled: null, method: "cash", payment: "1000.00", status: "applied", date: "2026-08-01", reference_number: null },
        { id: 7002, customer_id: 9001, job_id: 1, canceled: null, method: "echeque", payment: "1276.00", status: "applied", date: "2026-08-20", reference_number: "CHK 2211" },
        { id: 7003, customer_id: 9001, job_id: 1, canceled: "2026-08-21 10:00:00", method: "echeque", payment: "1276.00", status: "cancelled", date: "2026-08-20", cancel_note: "dup" },
      ],
      "2": [{ id: 7010, customer_id: 9002, job_id: 2, canceled: null, method: "cc", payment: 2276, status: "unapplied", date: "2026-09-01" }],
    },
    // Shaped like the API's vendor_bills listing with the vendor include. Job 1: two
    // suppliers, the carting company and a sub. Job 2: none yet.
    bills: {
      "1": [
        { id: 9101, job_id: 1, bill_date: "2026-08-15", due_date: "2026-10-15", bill_number: "NC-1", note: "shingles", total_amount: 6958.24, tax_amount: 0, origin: "JobProgress",
          vendor: { data: { id: 303837, first_name: "New", last_name: "Castle Building Products", display_name: "New Castle Building Products", origin: "QuickBooks" } } },
        { id: 9102, job_id: 1, bill_date: "2026-08-20", total_amount: "1200.50", vendor: { data: { id: 1, display_name: "QXO", origin: "QuickBooks" } } },
        { id: 9103, job_id: 1, bill_date: "2026-08-21", total_amount: 550, vendor: { data: { id: 2, display_name: "Bin Drop Waste Services", origin: "QuickBooks" } } },
        { id: 9104, job_id: 1, bill_date: "2026-08-25", total_amount: 4000, vendor: { data: { id: 3, display_name: "Lucy LD Construction Corp.", origin: "QuickBooks" } } },
      ],
    },
  };

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
    expect(r.counts).toMatchObject({
      stages_examined: 4, stages_tracked: 2, jobs_examined: 2, jobs_upserted: 2, jobs_moved_out: 0, locations_fetched: 2,
      financials_from_listing: 1, financial_summaries_fetched: 1, financial_summary_errors: 0,
      payments_jobs_fetched: 2, payments_upserted: 4, payments_retired: 0, payment_errors: 0,
      bills_jobs_fetched: 2, bills_upserted: 4, bills_retired: 0, bill_errors: 0,
    });
    expect(stub.calls).toContain("summary:2");
    expect(stub.calls).not.toContain("summary:1");
    expect(stub.calls.filter((c) => c === "payment-types")).toHaveLength(1);
    const stages = await db.owner.query(`SELECT code, name, jobs_count FROM jp_workflow_stage ORDER BY position`);
    expect(stages.rows.map((s) => s.code)).toEqual(["S-LEAD", "S-PROD-START", "S-COMPLETE", "S-PAID"]);
    const jobs = await db.owner.query(`SELECT jp_job_id, current_stage, stage_code, jp_customer_id, division, stage_seen_at IS NOT NULL AS tracked FROM jp_job ORDER BY jp_job_id`);
    expect(jobs.rows).toEqual([
      { jp_job_id: "1", current_stage: "Production Started", stage_code: "S-PROD-START", jp_customer_id: "9001", division: "ACR Roofing Division", tracked: true },
      { jp_job_id: "2", current_stage: "COMPLETED NEED FINAL PAYMENT!!", stage_code: "S-COMPLETE", jp_customer_id: "9002", division: "ACR Roofing Division", tracked: true },
    ]);
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM jp_job_location`)).rows[0].n).toBe(2);
  });

  it("fills the Weekly Job Sheet columns: people from the includes, money from the include or the summary", async () => {
    const rows = (await db.owner.query(
      `SELECT jp_job_id, rep_names, sub_contractor_names, completion_date::text, total_job_price::text AS price,
              total_change_order_amount::text AS co, total_job_revenue::text AS rev, total_payment_received::text AS paid,
              total_amount_owed::text AS owed, financials_fetched_at IS NOT NULL AS fetched
         FROM jp_job ORDER BY jp_job_id`)).rows;
    expect(rows).toEqual([
      { jp_job_id: "1", rep_names: "Jason Malarchak", sub_contractor_names: "Lucy", completion_date: "2026-09-02",
        price: "13999.00", co: "0.00", rev: "13999.00", paid: "2276.00", owed: "11723.00", fetched: true },
      // No include on the listing: the summary was read; revenue derived as price + change orders.
      { jp_job_id: "2", rep_names: null, sub_contractor_names: null, completion_date: null,
        price: "4552.00", co: "150.50", rev: "4702.50", paid: "2276.00", owed: "2426.50", fetched: true },
    ]);
    const payments = (await db.owner.query(
      `SELECT jp_payment_id, jp_job_id, amount::text, method, method_label, payment_date::text, canceled, reference_number
         FROM jp_job_payment ORDER BY jp_payment_id`)).rows;
    expect(payments).toEqual([
      { jp_payment_id: "7001", jp_job_id: "1", amount: "1000.00", method: "cash", method_label: "Cash", payment_date: "2026-08-01", canceled: false, reference_number: null },
      { jp_payment_id: "7002", jp_job_id: "1", amount: "1276.00", method: "echeque", method_label: "Check", payment_date: "2026-08-20", canceled: false, reference_number: "CHK 2211" },
      { jp_payment_id: "7003", jp_job_id: "1", amount: "1276.00", method: "echeque", method_label: "Check", payment_date: "2026-08-20", canceled: true, reference_number: null },
      { jp_payment_id: "7010", jp_job_id: "2", amount: "2276.00", method: "cc", method_label: "Credit Card", payment_date: "2026-09-01", canceled: false, reference_number: null },
    ]);
    const marks = (await db.owner.query(`SELECT jp_job_id, payments_fetched_total::text AS t, payments_fetched_at IS NOT NULL AS f, bills_fetched_at IS NOT NULL AS b FROM jp_job ORDER BY jp_job_id`)).rows;
    expect(marks).toEqual([{ jp_job_id: "1", t: "2276.00", f: true, b: true }, { jp_job_id: "2", t: "2276.00", f: true, b: true }]);
    const bills = (await db.owner.query(`SELECT jp_bill_id, vendor_name, category, total_amount::text AS amt, bill_date::text FROM jp_vendor_bill ORDER BY jp_bill_id`)).rows;
    expect(bills).toEqual([
      { jp_bill_id: "9101", vendor_name: "New Castle Building Products", category: "material", amt: "6958.24", bill_date: "2026-08-15" },
      { jp_bill_id: "9102", vendor_name: "QXO", category: "material", amt: "1200.50", bill_date: "2026-08-20" },
      { jp_bill_id: "9103", vendor_name: "Bin Drop Waste Services", category: "carting", amt: "550.00", bill_date: "2026-08-21" },
      { jp_bill_id: "9104", vendor_name: "Lucy LD Construction Corp.", category: "labor", amt: "4000.00", bill_date: "2026-08-25" },
    ]);
  });

  it("does not re-read fresh money, and leaves names alone when a sweep did not ask for them", async () => {
    stub.calls.length = 0;
    // Same listing again, but job 1 now comes WITHOUT the people includes (a
    // different sweep shape) — its rep and sub must survive the upsert.
    const bare = job(1, STAGES[0]!, { financial_details: SHEET_JOB_1.financial_details, completion_date: SHEET_JOB_1.completion_date });
    stub.inStages = [bare, job(2, STAGES[1]!)];
    const r = await runJobStageSync({ client: stubClient(stub), startedBy: "test" });
    expect(r.counts).toMatchObject({ financials_from_listing: 1, financial_summaries_fetched: 0, payments_jobs_fetched: 0, bills_jobs_fetched: 0 });
    expect(stub.calls.filter((c) => c.startsWith("summary:") || c.startsWith("payments:") || c.startsWith("bills:"))).toEqual([]);
    const row = (await db.owner.query(`SELECT rep_names, sub_contractor_names FROM jp_job WHERE jp_job_id = '1'`)).rows[0];
    expect(row).toEqual({ rep_names: "Jason Malarchak", sub_contractor_names: "Lucy" });
    stub.inStages = [job(1, STAGES[0]!, SHEET_JOB_1), job(2, STAGES[1]!)];
  });

  it("serves the sheet rows in the tab's vocabulary, with install date and crew fallback from the schedule", async () => {
    await db.owner.query(
      `INSERT INTO jp_schedule (jp_schedule_id, jp_job_id, title, start_at, end_at, crew_names)
       VALUES ('S1', '1', 'RR: Wayne/1 Main St/George Golab', '2026-08-28 12:00+00', '2026-08-28 20:00+00', '{Lucy}'),
              ('S2', '1', 'RR: day 2', '2026-08-29 12:00+00', '2026-08-29 20:00+00', '{Lucy}'),
              ('S3', '2', 'RR: Wayne/2 Main St/Joseph Lorent', '2026-09-03 12:00+00', '2026-09-03 20:00+00', '{DNC,Manny}'),
              ('S4', '2', 'RR: cancelled visit', '2026-08-20 12:00+00', '2026-08-20 20:00+00', '{Ghost}')`);
    await db.owner.query(`UPDATE jp_schedule SET deleted_at = now() WHERE jp_schedule_id = 'S4'`);

    const res = await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet", ...as("prod@allied.test") });
    expect(res.statusCode).toBe(200);
    const sheet = res.json();
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.sync?.status).toBe("completed");
    const [one, two] = sheet.rows as Record<string, unknown>[];
    expect(one).toMatchObject({
      jobId: "1", customerId: "9001", jobNumber: "2609-1-01", customer: "George Golab", city: "Wayne", label: "Wayne/1 Main St/George Golab",
      division: "ACR Roofing Division", stage: "Production Started", stageGroup: "production",
      salesRep: "Jason Malarchak", sub: "Lucy", scheduledInstallDate: "2026-08-28", saleDate: "2026-08-01", completionDate: "2026-09-02",
      gross: 13999, changeOrders: 0, totalRev: 13999, totalPayments: 2276, balanceOwed: 11723,
      // Deposit = first payment, progress = the rest, the canceled duplicate ignored.
      paymentMethod: "Cash/Check", deposit: 1000, progressPayments: 1276, paymentsCount: 2,
      // Vendor bills: suppliers in billing order, a carting bill, costs by category; crews on the schedules.
      materialVendor: "NCBP/QXO", containerScheduled: true, subScheduled: true,
      actualMaterial: 8158.74, actualLabor: 4000, actualCarting: 550, actualOther: null, billsCount: 4,
    });
    expect(one!["jpUrl"]).toContain("/customer-jobs/9001/job/1");
    // No sub on the job: the crews on its live schedules stand in; the retired visit's crew does not.
    expect(two).toMatchObject({
      jobId: "2", salesRep: null, sub: "DNC, Manny", scheduledInstallDate: "2026-09-03",
      gross: 4552, changeOrders: 150.5, totalRev: 4702.5, totalPayments: 2276, balanceOwed: 2426.5,
      paymentMethod: "Credit Card", deposit: 2276, progressPayments: null, paymentsCount: 1,
      materialVendor: null, containerScheduled: false, subScheduled: true, actualMaterial: null, billsCount: 0,
    });
    expect((await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet", ...as("rep@allied.test") })).statusCode).toBe(403);
  });

  it("exports the week as an Excel workbook in the tab's layout", async () => {
    const ExcelJS = (await import("exceljs")).default;
    // Job 1's visits are 8/28–8/29, job 2's live visit is 9/3: the week of 9/1–9/7 holds job 2 only.
    const res = await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet.xlsx?from=2026-09-01&to=2026-09-07", ...as("prod@allied.test") });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("spreadsheetml");
    expect(res.headers["content-disposition"]).toContain("weekly-job-sheet-2026-09-01-to-2026-09-07.xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload);
    const ws = wb.getWorksheet("WEEKLY JOB SHEET")!;
    // Row 1: the tab's headers at the tab's own letters, including the far-right JP columns.
    expect(ws.getCell("A1").value).toBe("Town/Address/Customer");
    expect(ws.getCell("B1").value).toBe("PIF");
    expect(ws.getCell("M1").value).toBe("Job Stage");
    expect(ws.getCell("AB1").value).toBe("Balance Owed");
    expect(ws.getCell("AC1").value).toBe("Job #");
    expect(ws.getCell("BS1").value).toBe("Actual Dealer Fee %");
    expect(ws.getCell("HU1").value).toBe("JP Job ID");
    expect(ws.getColumn("I").hidden).toBe(true);
    // Row 2: the week label, as above each block on the tab. Row 3: the job. Row 4: the total.
    expect(ws.getCell("A2").value).toBe("9/1/2026-9/7/2026");
    const job = ws.getRow(3);
    expect(job.getCell("A").value).toBe("Wayne/2 Main St/Joseph Lorent");
    expect(job.getCell("B").value).toBe(false);                 // checkbox, unticked
    expect(job.getCell("AC").value).toBe("2609-2-01");
    expect(job.getCell("M").value).toBe("COMPLETED NEED FINAL PAYMENT!!");
    expect(job.getCell("R").value).toBe(4552);
    expect(job.getCell("R").numFmt).toBe('"$"#,##0.00');
    expect((job.getCell("Q").value as Date).toISOString().slice(0, 10)).toBe("2026-08-01");
    expect(job.getCell("T").value).toMatchObject({ formula: "R3+S3", result: 4702.5 });
    expect(job.getCell("AA").value).toMatchObject({ formula: "SUM(Y3:Z3)" });
    expect(job.getCell("AB").value).toMatchObject({ formula: "T3-AA3" });
    expect(job.getCell("U").value).toBe("Credit Card");
    expect(job.getCell("U").dataValidation).toBeUndefined();          // synced: no dropdown to reject it
    expect(job.getCell("AE").dataValidation).toMatchObject({ type: "list" }); // hand-filled: the tab's dropdown
    expect(job.getCell("HU").value).toBe("2");
    expect(job.getCell("HY").value).toBe("Synced from JobProgress API");
    expect(job.getCell("AJ").value).toBe(true);                   // sub scheduled: crew on its 9/3 visit
    expect(job.getCell("AI").value).toBe(false);                  // no carting bill on job 2
    expect(job.getCell("BM").value).toMatchObject({ formula: 'IF(COUNT(BH3:BL3)=0,"",SUM(BH3:BL3))' });
    expect(ws.getCell("A4").value).toBe("Weekly Total");
    expect((ws.getCell("R4").value as { formula: string }).formula).toBe("SUM(R3:R3)");
    expect(wb.getWorksheet("JP DETAIL")!.getRow(2).getCell(8).value).toBe("9/3/2026");
    expect(wb.getWorksheet("About")).toBeTruthy();

    // No week → every tracked job and no week row; a malformed week → 400; a sales rep → 403.
    const all = await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet.xlsx", ...as("prod@allied.test") });
    const wbAll = new ExcelJS.Workbook();
    await wbAll.xlsx.load(all.rawPayload);
    const wsAll = wbAll.getWorksheet("WEEKLY JOB SHEET")!;
    expect(wsAll.getCell("A2").value).not.toBe("9/1/2026-9/7/2026");
    expect(wsAll.getCell("A4").value).toBe("Weekly Total"); // header + 2 jobs + total
    // Job 1 (row 2, newest sale first ties → job number order): vendor bills fill AD, AI and the ledger.
    const one = wsAll.getRow(2);
    expect(one.getCell("AC").value).toBe("2609-1-01");
    expect(one.getCell("AD").value).toBe("NCBP/QXO");
    expect(one.getCell("AI").value).toBe(true);
    expect(one.getCell("BH").value).toBe(8158.74);
    expect(one.getCell("BI").value).toBe(4000);
    expect(one.getCell("BJ").value).toBe(550);
    expect(one.getCell("BL").value).toBeNull();
    expect((await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet.xlsx?from=9/1/2026", ...as("prod@allied.test") })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet.xlsx", ...as("rep@allied.test") })).statusCode).toBe(403);
  });

  it("re-reads a job's payments only when its payment total changes, retiring ones that vanished", async () => {
    // A second check clears the balance on job 2; the office also deleted the card payment.
    stub.summaries["2"] = { total_job_price: 4552, total_change_order_amount: "150.50", total_payment_received: 4702.5, total_amount_owed: 0 };
    stub.payments["2"] = [
      { id: 7011, customer_id: 9002, job_id: 2, canceled: null, method: "echeque", payment: 2276, status: "applied", date: "2026-09-01" },
      { id: 7012, customer_id: 9002, job_id: 2, canceled: null, method: "echeque", payment: 2426.5, status: "applied", date: "2026-09-08" },
    ];
    await db.owner.query(`UPDATE jp_job SET financials_fetched_at = now() - interval '13 hours' WHERE jp_job_id = '2'`);
    stub.calls.length = 0;
    const r = await runJobStageSync({ client: stubClient(stub), startedBy: "test" });
    expect(r.counts).toMatchObject({ financial_summaries_fetched: 1, payments_jobs_fetched: 1, payments_upserted: 2, payments_retired: 1 });
    expect(stub.calls.filter((c) => c.startsWith("payments:"))).toEqual(["payments:2"]);
    const two = (await app.inject({ method: "GET", url: "/api/production/weekly-job-sheet", ...as("prod@allied.test") })).json()
      .rows.find((x: { jobId: string }) => x.jobId === "2");
    expect(two).toMatchObject({ paymentMethod: "Check", deposit: 2276, progressPayments: 2426.5, totalPayments: 4702.5, balanceOwed: 0, paymentsCount: 2 });
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
