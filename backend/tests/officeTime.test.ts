/**
 * Migration 0016 (office time) against real rows: the data repair, its
 * collision handling, and the reverse direction.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { migrateUp, migrateDown } from "../src/db/migrate.js";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";

const reachable = await pgReachable();
requirePg(reachable);

describe.skipIf(!reachable)("0016_office_time data repair", () => {
  let db: TestDb;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = await createTestDb("officetime");
    await migrateDown(db.owner, 1, () => {}); // back to 0015: the world before the repair

    const insert = async (key: string, row: Record<string, unknown>) => {
      const cols = Object.keys(row);
      const { rows } = await db.owner.query<{ id: string }>(
        `INSERT INTO appointment (${cols.map((c) => `"${c}"`).join(",")}, created_by)
         VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")}, 'jobprogress-sync') RETURNING id`,
        cols.map((c) => row[c]));
      ids[key] = rows[0]!.id;
    };
    // A 5:30 PM estimate the API reported as 21:30 UTC.
    await insert("a", { crm_lead_id: "L-1", customer_name: "A", appointment_date: "2026-09-08", appointment_time: "21:30", appointment_record_id: "31937935" });
    // An 8:30 PM estimate the API put on the next UTC day.
    await insert("b", { crm_lead_id: "L-2", customer_name: "B", appointment_date: "2026-09-09", appointment_time: "00:30", appointment_record_id: "x2" });
    // Hand-entered copy with the real time, already debriefed …
    await insert("c", { crm_lead_id: "L-3", customer_name: "C", appointment_date: "2026-09-08", appointment_time: "10:00", debrief_status: "Submitted" });
    // … and the JobProgress copy of the same appointment in UTC.
    await insert("d", { crm_lead_id: "L-3", customer_name: "C", appointment_date: "2026-09-08", appointment_time: "14:00", appointment_record_id: "x4", debrief_status: "Missing" });
    // Hand-entered with no JobProgress id: must not move.
    await insert("e", { crm_lead_id: "L-5", customer_name: "E", appointment_date: "2026-09-08", appointment_time: "09:00" });

    await db.owner.query(
      `INSERT INTO debrief (submitted_by, customer_name, appointment_date, sales_rep, appointment_setter, appointment_outcome, crm_lead_id, appointment_id, created_by)
       VALUES ('t', 'C', '2026-09-08', 'Jason', 'Ashley', 'Demo Completed — Sale', 'L-3', $1, 't')`, [ids.d]);

    await db.owner.query(
      `INSERT INTO jp_appointment (jp_appointment_id, crm_lead_id, appointment_date, appointment_time, raw)
       VALUES ('1', 'L-1', '2026-09-08', '21:30', '{"start_date_time":"2026-09-08 21:30:00"}'),
              ('2', 'L-2', '2026-09-09', '00:30', '{"start_date_time":"2026-09-09 00:30:00"}')`);

    await migrateUp(db.owner, () => {});
  });
  afterAll(async () => db?.drop());

  const appt = async (id: string) =>
    (await db.owner.query(`SELECT appointment_date::text AS d, appointment_time AS t, appointment_record_id AS r, debrief_status AS s FROM appointment WHERE id = $1`, [id])).rows[0];

  it("moves JobProgress rows from UTC to the office clock", async () => {
    expect(await appt(ids.a!)).toMatchObject({ d: "2026-09-08", t: "17:30" });
    expect(await appt(ids.b!)).toMatchObject({ d: "2026-09-08", t: "20:30" });
  });

  it("leaves hand-entered rows alone", async () => {
    expect(await appt(ids.e!)).toMatchObject({ d: "2026-09-08", t: "09:00" });
  });

  it("merges a UTC copy into the hand-entered row it duplicates", async () => {
    expect(await appt(ids.d!)).toBeUndefined();
    expect(await appt(ids.c!)).toMatchObject({ d: "2026-09-08", t: "10:00", r: "x4", s: "Submitted" });
    const { rows } = await db.owner.query(`SELECT appointment_id FROM debrief WHERE crm_lead_id = 'L-3'`);
    expect(rows[0]!.appointment_id).toBe(ids.c);
  });

  it("gives the mirror an exact instant and office-clock date/time", async () => {
    const { rows } = await db.owner.query(
      `SELECT jp_appointment_id AS id, appointment_date::text AS d, appointment_time AS t, starts_at FROM jp_appointment ORDER BY 1`);
    expect(rows[0]).toMatchObject({ id: "1", d: "2026-09-08", t: "17:30" });
    expect((rows[0]!.starts_at as Date).toISOString()).toBe("2026-09-08T21:30:00.000Z");
    expect(rows[1]).toMatchObject({ id: "2", d: "2026-09-08", t: "20:30" });
  });

  it("puts the times back on UTC when reverted", async () => {
    await migrateDown(db.owner, 1, () => {});
    expect(await appt(ids.a!)).toMatchObject({ d: "2026-09-08", t: "21:30" });
    expect(await appt(ids.b!)).toMatchObject({ d: "2026-09-09", t: "00:30" });
    expect(await appt(ids.e!)).toMatchObject({ d: "2026-09-08", t: "09:00" });
    const { rows } = await db.owner.query(`SELECT appointment_time AS t FROM jp_appointment WHERE jp_appointment_id = '1'`);
    expect(rows[0]!.t).toBe("21:30");
    await migrateUp(db.owner, () => {});
    expect(await appt(ids.a!)).toMatchObject({ t: "17:30" });
  });
});
