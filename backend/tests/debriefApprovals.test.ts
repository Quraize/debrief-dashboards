/**
 * Manager approval of "No Demo — DQ / Do Not Reset" debriefs: the trigger that
 * starts them pending, the paginated table, and who may decide.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { hashPassword } from "../src/auth/crypto.js";

const reachable = await pgReachable();
requirePg(reachable);

const DQ = "No Demo — DQ / Do Not Reset";
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
async function seedUser(email: string, role: string, fullName: string) {
  await db.owner.query(`INSERT INTO app_user (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4)`, [email, fullName, role, await hashPassword(PASSWORD)]);
  const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: PASSWORD } });
  sessions.set(email, { cookie: cookieFrom(res, "allied_session"), csrf: cookieFrom(res, "allied_csrf") });
}
async function debrief(customer: string, outcome: string, over: Record<string, unknown> = {}): Promise<string> {
  const { rows } = await db.owner.query<{ id: string }>(
    `INSERT INTO debrief (submitted_by, customer_name, appointment_date, sales_rep, appointment_setter, appointment_outcome, dq_reason, created_by, approval_status)
     VALUES ('rep@allied.test', $1, '2026-09-10', 'Jason Malarchak', 'Ashley Pascual', $2, $3, 'rep@allied.test', $4) RETURNING id`,
    [customer, outcome, over["dq_reason"] ?? null, over["approval_status"] ?? null]);
  return rows[0]!.id;
}

describe.skipIf(!reachable)("debrief approvals", () => {
  beforeAll(async () => {
    db = await createTestDb("approvals");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    process.env.DATABASE_URL_APP = `postgres://allied_app:dev_app@${host}/${db.name}`;
    process.env.AUTH_LOGIN_RATE_MAX = "10000"; process.env.RATE_LIMIT_GLOBAL_MAX = "10000";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
    await seedUser("pm@allied.test", "project_manager", "Pat Manager");
    await seedUser("rep@allied.test", "outside_sales_rep", "Jason Malarchak");
    await seedUser("admin@allied.test", "admin", "Ada Admin");
  });
  afterAll(async () => {
    await app?.close();
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("starts a DQ debrief pending and leaves other outcomes alone, whatever the client sent", async () => {
    const a = await debrief("Renter Row", DQ, { dq_reason: "Tenant, not the owner" });
    const b = await debrief("Sale Row", "Demo Completed — Sale", { approval_status: "approved" }); // nonsense the trigger discards
    const rows = (await db.owner.query(`SELECT customer_name, approval_status FROM debrief ORDER BY customer_name`)).rows;
    expect(rows).toEqual([{ customer_name: "Renter Row", approval_status: "pending" }, { customer_name: "Sale Row", approval_status: null }]);
    // Changing the outcome away from DQ drops the approval; changing to DQ starts it pending.
    await db.owner.query(`UPDATE debrief SET approval_status = 'approved', approved_by_name = 'X' WHERE id = $1`, [a]);
    await db.owner.query(`UPDATE debrief SET appointment_outcome = 'No Demo — Do Not Reset' WHERE id = $1`, [a]);
    expect((await db.owner.query(`SELECT approval_status, approved_by_name FROM debrief WHERE id = $1`, [a])).rows[0]).toEqual({ approval_status: null, approved_by_name: null });
    await db.owner.query(`UPDATE debrief SET appointment_outcome = $2 WHERE id = $1`, [b, DQ]);
    expect((await db.owner.query(`SELECT approval_status FROM debrief WHERE id = $1`, [b])).rows[0]).toEqual({ approval_status: "pending" });
    await db.owner.query(`DELETE FROM debrief`);
  });

  it("lists the DQ debriefs, pending first, paginated, with counts by status", async () => {
    for (let i = 1; i <= 27; i++) await debrief(`Customer ${String(i).padStart(2, "0")}`, DQ, { dq_reason: `reason ${i}` });
    await debrief("Not DQ", "Demo Completed — Sale");
    const p1 = (await app.inject({ method: "GET", url: "/api/debriefs/approvals?status=pending&limit=25", ...as("pm@allied.test") })).json();
    expect(p1.total).toBe(27); expect(p1.pages).toBe(2); expect(p1.rows).toHaveLength(25);
    expect(p1.counts).toEqual({ pending: 27, approved: 0, rejected: 0 });
    expect(p1.rows[0].approval_status).toBe("pending");
    expect(p1.rows[0].dq_reason).toMatch(/^reason /);
    const p2 = (await app.inject({ method: "GET", url: "/api/debriefs/approvals?status=pending&limit=25&page=2", ...as("pm@allied.test") })).json();
    expect(p2.rows).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: "/api/debriefs/approvals?status=bogus", ...as("pm@allied.test") })).statusCode).toBe(400);
  });

  it("lets a project manager approve or reject under their own name; a rep may not", async () => {
    const { rows } = await db.owner.query<{ id: string }>(`SELECT id FROM debrief WHERE appointment_outcome = $1 ORDER BY customer_name LIMIT 2`, [DQ]);
    const [first, second] = rows.map((r) => r.id);
    const ok = await app.inject({ method: "POST", url: `/api/debriefs/${first}/approval`, payload: { decision: "approve", note: "Confirmed with the setter" }, ...as("pm@allied.test") });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data).toMatchObject({ approval_status: "approved", approved_by: "pm@allied.test", approved_by_name: "Pat Manager", approval_note: "Confirmed with the setter" });
    expect(ok.json().data.approved_at).toBeTruthy();
    const rej = await app.inject({ method: "POST", url: `/api/debriefs/${second}/approval`, payload: { decision: "reject" }, ...as("pm@allied.test") });
    expect(rej.json().data.approval_status).toBe("rejected");
    expect((await app.inject({ method: "POST", url: `/api/debriefs/${first}/approval`, payload: { decision: "approve" }, ...as("rep@allied.test") })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/debriefs/approvals", ...as("rep@allied.test") })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: `/api/debriefs/${first}/approval`, payload: { decision: "maybe" }, ...as("pm@allied.test") })).statusCode).toBe(400);
    // A debrief that does not need approval cannot be "approved".
    const sale = (await db.owner.query<{ id: string }>(`SELECT id FROM debrief WHERE customer_name = 'Not DQ'`)).rows[0]!.id;
    expect((await app.inject({ method: "POST", url: `/api/debriefs/${sale}/approval`, payload: { decision: "approve" }, ...as("pm@allied.test") })).statusCode).toBe(404);
    const all = (await app.inject({ method: "GET", url: "/api/debriefs/approvals?status=all&limit=100", ...as("pm@allied.test") })).json();
    expect(all.counts).toEqual({ pending: 25, approved: 1, rejected: 1 });
    expect(all.rows[0].approval_status).toBe("pending"); // pending first
    expect(all.rows.at(-1).approval_status).not.toBe("pending");
  });

  it("counts the waiting queues per role, and hides the ones a role may not see", async () => {
    // Leaves 25 pending DQ debriefs from the test above.
    for (const [id, status] of [["c1", "pending"], ["c2", "pending"], ["c3", "applied"]] as const) {
      await db.owner.query(
        `INSERT INTO jp_price_candidate (jp_job_id, proposal_id, status) VALUES ($1, $1, $2)`, [id, status]);
    }
    const admin = (await app.inject({ method: "GET", url: "/api/pending-counts", ...as("admin@allied.test") })).json();
    expect(admin.counts).toEqual({ priceReview: 2, debriefApprovals: 25 });
    // A project manager approves debriefs but has no business with contract prices.
    const pm = (await app.inject({ method: "GET", url: "/api/pending-counts", ...as("pm@allied.test") })).json();
    expect(pm.counts).toEqual({ debriefApprovals: 25 });
    // A rep has no queue at all — and is told nothing about anyone else's.
    const rep = await app.inject({ method: "GET", url: "/api/pending-counts", ...as("rep@allied.test") });
    expect(rep.statusCode).toBe(200);
    expect(rep.json().counts).toEqual({});
    expect((await app.inject({ method: "GET", url: "/api/pending-counts" })).statusCode).toBe(401);
  });
});
