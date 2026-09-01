/**
 * Appointment identity + idempotency.
 *
 * This is the regression suite for the duplicate-appointment bug
 * (MIGRATION_PLAN.md §3.2): Base44 matched new records against a 500-row window
 * and silently re-created anything older on every run.
 *
 * Two things have to hold for the fix to work:
 *   1. the database's identity_key must agree with canonicalAppointmentKey()
 *      in @allied/shared, exactly - not approximately;
 *   2. re-importing the same rows must change nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { canonicalAppointmentKey } from "@allied/shared/salesAppointment";
import { createTestDb, pgReachable, requirePg, asUser, expectDenied, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

const MGR = { email: "manager@allied.test", role: "sales_manager" };
let db: TestDb;

/** Inputs chosen to exercise every branch of norm(): case, padding, internal runs, blanks. */
const CASES: Array<[string | null, string | null, string | null]> = [
  ["ABC123", "2026-08-01", "09:30"],
  [" ABC123 ", "2026-08-01", " 09:30 "],
  ["abc123", "2026-08-01", "09:30"],
  ["J  1", "2026-08-01", "A   B"],
  ["MiXeD-CaSe", "2026-12-31", "23:59"],
  ["", "2026-08-01", ""],
  [null, null, null],
  ["  ", "2026-01-01", "  "],
  ["lead|with|pipes", "2026-02-03", "1:00 PM"],
  ["  spaced   out  id ", "2026-06-15", "  8 : 30  "],
];

describe.skipIf(!reachable)("appointment identity", () => {
  beforeAll(async () => { db = await createTestDb("identity"); });
  afterAll(async () => db?.drop());

  it("the SQL generated column matches canonicalAppointmentKey() exactly", async () => {
    // If these two ever diverge, the unique constraint stops protecting the
    // thing the application thinks it protects. That is why this is asserted
    // per-case rather than spot-checked.
    const rows = await asUser(db.app, MGR.email, MGR.role, async (c) => {
      const out: string[] = [];
      for (const [lead, date, time] of CASES) {
        const { rows } = await c.query<{ identity_key: string }>(
          `SELECT allied_norm($1::text) || '|' || allied_date_key($2::date) || '|' || allied_norm($3::text)
             AS identity_key`,
          [lead, date, time],
        );
        out.push(rows[0]!.identity_key);
      }
      return out;
    });

    CASES.forEach(([lead, date, time], i) => {
      expect(rows[i], `case ${JSON.stringify([lead, date, time])}`)
        .toBe(canonicalAppointmentKey(lead, date, time));
    });
  });

  it("computes identity_key on insert without the caller supplying it", async () => {
    const key = await asUser(db.app, MGR.email, MGR.role, async (c) => {
      const { rows } = await c.query<{ identity_key: string }>(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
         VALUES ('Smith', ' LEAD-9 ', '2026-08-01', ' 09:30 ') RETURNING identity_key`,
      );
      return rows[0]!.identity_key;
    });
    expect(key).toBe("lead-9|2026-08-01|09:30");
    expect(key).toBe(canonicalAppointmentKey(" LEAD-9 ", "2026-08-01", " 09:30 "));
  });

  it("rejects a duplicate that differs only in case and whitespace", async () => {
    const err = await expectDenied(
      asUser(db.app, MGR.email, MGR.role, (c) =>
        c.query(
          `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
           VALUES ('Smith Again', 'lead-9', '2026-08-01', '09:30')`,
        ),
      ),
    );
    expect(err.message).toMatch(/appointment_identity_uniq|duplicate key/i);
  });

  it("treats the same job on a different date or time as a separate appointment", async () => {
    const n = await asUser(db.app, MGR.email, MGR.role, async (c) => {
      const a = await c.query(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
         VALUES ('Smith', 'LEAD-9', '2026-08-02', '09:30')`);
      const b = await c.query(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
         VALUES ('Smith', 'LEAD-9', '2026-08-01', '14:00')`);
      return (a.rowCount ?? 0) + (b.rowCount ?? 0);
    });
    expect(n).toBe(2); // reset / rehash / follow-up are genuinely distinct records
  });

  it("does not let rows with no lead id duplicate freely", async () => {
    // A plain UNIQUE over nullable columns would treat every NULL as distinct
    // and let these both through. coalescing into one text key closes that hole.
    await asUser(db.app, MGR.email, MGR.role, (c) =>
      c.query(`INSERT INTO appointment (customer_name, appointment_date, appointment_time)
               VALUES ('No Lead', '2026-09-09', '10:00')`));
    const err = await expectDenied(
      asUser(db.app, MGR.email, MGR.role, (c) =>
        c.query(`INSERT INTO appointment (customer_name, appointment_date, appointment_time)
                 VALUES ('No Lead Again', '2026-09-09', '10:00')`)),
    );
    expect(err.message).toMatch(/appointment_identity_uniq|duplicate key/i);
  });
});

describe.skipIf(!reachable)("import idempotency", () => {
  let idb: TestDb;
  beforeAll(async () => { idb = await createTestDb("idem"); });
  afterAll(async () => idb?.drop());

  const BATCH = [
    ["Alpha Roofing", "L-1", "2026-07-01", "09:00"],
    ["Beta Siding", "L-2", "2026-07-01", "11:00"],
    ["Gamma Repair", "L-3", "2026-07-02", "14:00"],
    ["Alpha Roofing", "l-1 ", "2026-07-01", " 09:00"], // same appointment, dirtier
  ];

  // Sequential, not Promise.all: a single pg client cannot run overlapping
  // queries, and ON CONFLICT ordering is part of what is being asserted.
  const upsert = async (c: import("pg").PoolClient) => {
    for (const [name, lead, date, time] of BATCH) {
      await c.query(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
         VALUES ($1,$2,$3::date,$4)
         ON CONFLICT (identity_key) DO UPDATE
           SET customer_name = EXCLUDED.customer_name,
               updated_at    = now()`,
        [name, lead, date, time],
      );
    }
  };

  it("collapses same-identity rows within a single batch", async () => {
    const n = await asUser(idb.app, MGR.email, MGR.role, async (c) => {
      await upsert(c);
      return (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM appointment")).rows[0]!.n;
    });
    expect(n).toBe(3); // four input rows, three real appointments
  });

  it("creates nothing new when the same batch is imported again", async () => {
    // This is the actual regression: on Base44 a second run re-created rows
    // that had fallen outside the 500-row match window.
    const n = await asUser(idb.app, MGR.email, MGR.role, async (c) => {
      await upsert(c);
      await upsert(c);
      return (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM appointment")).rows[0]!.n;
    });
    expect(n).toBe(3);
  });

  it("still applies updates on conflict rather than silently ignoring them", async () => {
    const name = await asUser(idb.app, MGR.email, MGR.role, async (c) => {
      await c.query(
        `INSERT INTO appointment (customer_name, crm_lead_id, appointment_date, appointment_time)
         VALUES ('Alpha Roofing LLC','L-1','2026-07-01','09:00')
         ON CONFLICT (identity_key) DO UPDATE SET customer_name = EXCLUDED.customer_name`);
      const { rows } = await c.query<{ customer_name: string }>(
        `SELECT customer_name FROM appointment WHERE crm_lead_id = 'L-1'`);
      return rows[0]!.customer_name;
    });
    expect(name).toBe("Alpha Roofing LLC");
  });
});
