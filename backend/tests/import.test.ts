/**
 * Base44 export importer.
 *
 * Exercised end-to-end through the real CLI against a real database, because
 * the failure modes this guards against are all integration failures: an empty
 * string reaching a date column, an id not surviving, a second run duplicating
 * everything.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";

const run = promisify(execFile);
const reachable = await pgReachable();
requirePg(reachable);

const BACKEND = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(BACKEND, "scripts", "import-base44-export.ts");

// Shaped exactly like a Base44 export, including the things that break imports:
// "" in place of a missing date, created_date rather than created_at, extra
// metadata fields we do not model, and two rows that are the same appointment.
const APPOINTMENTS = [
  {
    id: "appt-0001", customer_name: "Alpha Roofing", crm_lead_id: "L-1",
    appointment_date: "2026-07-01", appointment_time: "09:00",
    phone: "5551234567", sale_date: "", demo_date: "", reset_date: "",
    is_sales_appointment: true, created_date: "2026-06-20T10:00:00Z",
    created_by: "setter@allied.test", _base44_internal: "ignore me",
  },
  {
    id: "appt-0002", customer_name: "Beta Siding", crm_lead_id: "L-2",
    appointment_date: "2026-07-02", appointment_time: "11:00",
    lead_created_date: "", created_date: "2026-06-21T10:00:00Z",
    created_by: "setter@allied.test",
  },
  {
    // Same identity as appt-0001, dirtier. Must collapse, not duplicate.
    id: "appt-0003", customer_name: "Alpha Roofing", crm_lead_id: " l-1 ",
    appointment_date: "2026-07-01", appointment_time: " 09:00 ",
    created_date: "2026-06-22T10:00:00Z", created_by: "setter@allied.test",
  },
];

const DEBRIEFS = [
  {
    id: "deb-0001", appointment_id: "appt-0002", customer_name: "Beta Siding",
    appointment_date: "2026-07-02", sales_rep: "Rep A", appointment_setter: "Setter A",
    appointment_outcome: "Demo Completed — Sale", submitted_by: "Rep A",
    sale_amount: 18500.5, first_price_given: 21000, prices_given: 2,
    financing_offered: true, reset_needed: false,
    sale_signed_date: "", follow_up_date: "", contingency_signed_date: "",
    created_date: "2026-07-02T18:00:00Z", created_by: "rep.a@allied.test",
  },
];

let db: TestDb;
let dir: string;

describe.skipIf(!reachable)("Base44 export import", () => {
  beforeAll(async () => {
    db = await createTestDb("import");
    dir = mkdtempSync(join(tmpdir(), "allied-export-"));
    writeFileSync(join(dir, "Appointment.json"), JSON.stringify(APPOINTMENTS));
    writeFileSync(join(dir, "Debrief.json"), JSON.stringify(DEBRIEFS));
  });
  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.drop();
  });

  const importOnce = () =>
    run("npx", ["tsx", SCRIPT, dir], {
      cwd: BACKEND,
      env: { ...process.env, DATABASE_URL: ownerUrl() },
      shell: process.platform === "win32",
    });

  const ownerUrl = () => {
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    return `postgres://allied_owner:dev_owner@${host}/${db.name}`;
  };

  const count = async (t: string) =>
    (await db.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;

  it("imports without rejecting any row", async () => {
    const { stdout } = await importOnce();
    expect(stdout).toContain("every row accounted for");
  }, 60_000);

  it("collapses the duplicate appointment instead of importing three", async () => {
    expect(await count("appointment")).toBe(2);
  });

  it("preserves Base44 ids so debrief.appointment_id still resolves", async () => {
    const { rows } = await db.owner.query<{ id: string; appointment_id: string }>(
      `SELECT d.id, d.appointment_id FROM debrief d JOIN appointment a ON a.id = d.appointment_id`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("deb-0001");
    expect(rows[0]!.appointment_id).toBe("appt-0002");
  });

  it("turns empty-string dates into NULL rather than failing the import", async () => {
    // The single most common way a migration import dies half-finished.
    const { rows } = await db.owner.query<{ sale_date: unknown; demo_date: unknown }>(
      `SELECT sale_date, demo_date FROM appointment WHERE id = 'appt-0001'`);
    expect(rows[0]!.sale_date).toBeNull();
    expect(rows[0]!.demo_date).toBeNull();
  });

  it("keeps money exact, to the cent", async () => {
    const { rows } = await db.owner.query<{ sale_amount: string }>(
      `SELECT sale_amount FROM debrief WHERE id = 'deb-0001'`);
    // numeric comes back as a string precisely so 18500.50 cannot become 18500.5000000001
    expect(rows[0]!.sale_amount).toBe("18500.50");
  });

  it("carries created_by through, so the write-own policy has something to match", async () => {
    const { rows } = await db.owner.query<{ created_by: string }>(
      `SELECT created_by FROM debrief WHERE id = 'deb-0001'`);
    expect(rows[0]!.created_by).toBe("rep.a@allied.test");
  });

  it("maps created_date onto created_at", async () => {
    const { rows } = await db.owner.query<{ created_at: Date }>(
      `SELECT created_at FROM appointment WHERE id = 'appt-0001'`);
    expect(rows[0]!.created_at.toISOString()).toBe("2026-06-20T10:00:00.000Z");
  });

  it("keeps the ORIGINAL created_at when a duplicate merges into it", async () => {
    // appt-0003 is the same appointment as appt-0001 but was created two days
    // later. Merging it must not rewrite when the record came into existence -
    // and must not rewrite created_by either, since the write-own policy
    // compares against it.
    const { rows } = await db.owner.query<{ created_at: Date; created_by: string }>(
      `SELECT created_at, created_by FROM appointment WHERE identity_key = 'l-1|2026-07-01|09:00'`);
    expect(rows[0]!.created_at.toISOString()).toBe("2026-06-20T10:00:00.000Z");
    expect(rows[0]!.created_by).toBe("setter@allied.test");
  });

  it("is idempotent — a second import creates nothing new", async () => {
    const before = await count("appointment");
    const beforeD = await count("debrief");
    await importOnce();
    expect(await count("appointment")).toBe(before);
    expect(await count("debrief")).toBe(beforeD);
  }, 60_000);

  it("computes identity_key for imported rows", async () => {
    const { rows } = await db.owner.query<{ identity_key: string }>(
      `SELECT identity_key FROM appointment WHERE id = 'appt-0001'`);
    expect(rows[0]!.identity_key).toBe("l-1|2026-07-01|09:00");
  });
});
