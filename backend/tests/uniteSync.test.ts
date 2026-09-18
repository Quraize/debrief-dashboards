/**
 * The Unite call sync against a real database and a stub client: users and
 * outside calls land, internal calls do not, calls match leads by number and
 * keep matching on later runs, re-runs change nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { runUniteCallSync, mapCall, mapUser, uniteMirrorStatus } from "../src/integrations/intermedia/syncCalls.js";
import type { UniteClient, UniteCallDetail, UniteContact } from "../src/integrations/intermedia/client.js";

const reachable = await pgReachable();
requirePg(reachable);

const NOW = new Date("2026-09-18T13:00:00Z");
const users: UniteContact[] = [
  { id: "u-jason", type: "user", displayName: "Jason  Malarchak", email: "j@x", phoneNumbers: [{ type: "Phone", number: "+1 201 555 0100", internationalFormatNumber: "+12015550100" }], pbx: { enabled: true, extension: "408" } },
  { id: "u-aa", type: "user", displayName: "Allied AA Day", email: null, phoneNumbers: [], pbx: { enabled: true, extension: "500" } },
  { id: "room", type: "room", displayName: "Conference", email: null, phoneNumbers: [], pbx: null },
];
const call = (id: string, over: Partial<UniteCallDetail> = {}): UniteCallDetail => ({
  id, globalCallId: `g-${id}`, start: "2026-09-17T14:02:11Z", duration: 300, direction: "inbound",
  from: { number: "+12015550134", name: "CUSTOMER", userUniqueId: null, device: null },
  to: { number: "408", name: "Jason Malarchak", userUniqueId: "u-jason", device: { deviceType: "pbx" } },
  group: null, ...over,
});
let calls: UniteCallDetail[] = [];
const stub = {
  listAccountContacts: async () => users,
  listCallDetails: async () => ({ calls, totalCalls: calls.length }),
} as unknown as UniteClient;

describe("mappers", () => {
  it("keys a user's numbers and drops internal calls", () => {
    expect(mapUser(users[0]!)).toMatchObject({ unite_user_id: "u-jason", display_name: "Jason  Malarchak", extension: "408", numbers: ["2015550100"] });
    expect(mapCall(call("x", { direction: "internal" }))).toBeNull();
    const inbound = mapCall(call("in"))!;
    expect(inbound).toMatchObject({ direction: "inbound", external_key: "2015550134", rep_user_id: "u-jason", from_name: "CUSTOMER" });
    const outbound = mapCall(call("out", { direction: "outbound", from: { number: "408", name: "Jason", userUniqueId: "u-jason", device: null }, to: { number: "+19735550100", name: null, userUniqueId: null, device: null } }))!;
    expect(outbound).toMatchObject({ direction: "outbound", external_key: "9735550100", rep_user_id: "u-jason" });
    expect(mapCall(call("bad", { start: "not a date" }))).toBeNull();
  });
});

describe.skipIf(!reachable)("runUniteCallSync", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb("unite");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    // One lead with a known number; a second, older lead sharing it (the newer one must win).
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name, jp_created_at) VALUES ('9001','George Golab','2026-09-01'), ('8000','Old Golab','2025-01-01')`);
    await db.owner.query(`INSERT INTO jp_customer_phone (jp_customer_id, phone_key) VALUES ('9001','2015550134'), ('8000','2015550134')`);
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("mirrors extensions and outside calls, skips internal ones, matches by number to the newest lead", async () => {
    calls = [
      call("c1"),
      call("c2", { direction: "outbound", start: "2026-09-17T15:30:00Z", from: { number: "408", name: "Jason", userUniqueId: "u-jason", device: null }, to: { number: "+19735550100", name: null, userUniqueId: null, device: null } }),
      call("c3", { direction: "internal", from: { number: "408", name: "Jason", userUniqueId: "u-jason", device: null }, to: { number: "404", name: "Ashley", userUniqueId: "u-ashley", device: null } }),
      call("c4", { direction: "inbound", from: { number: "Anonymous", name: null, userUniqueId: null, device: null } }),
    ];
    const r = await runUniteCallSync({ client: stub, startedBy: "test", now: NOW });
    expect(r.status).toBe("completed");
    expect(r.counts).toMatchObject({ users_examined: 3, users_upserted: 2, calls_examined: 4, calls_upserted: 3, calls_internal_skipped: 1, calls_without_number: 1, calls_matched_now: 1, calls_unmatched_total: 1 });
    const rows = (await db.owner.query(`SELECT unite_call_id, direction, external_key, rep_user_id, jp_customer_id FROM unite_call ORDER BY unite_call_id`)).rows;
    expect(rows).toEqual([
      { unite_call_id: "c1", direction: "inbound", external_key: "2015550134", rep_user_id: "u-jason", jp_customer_id: "9001" }, // newest lead, not 8000
      { unite_call_id: "c2", direction: "outbound", external_key: "9735550100", rep_user_id: "u-jason", jp_customer_id: null },
      { unite_call_id: "c4", direction: "inbound", external_key: null, rep_user_id: "u-jason", jp_customer_id: null },
    ]);
    const u = (await db.owner.query(`SELECT unite_user_id, extension, rep_key FROM unite_user ORDER BY unite_user_id`)).rows;
    expect(u).toEqual([{ unite_user_id: "u-aa", extension: "500", rep_key: "allied aa day" }, { unite_user_id: "u-jason", extension: "408", rep_key: "jason malarchak" }]);
    const run = (await db.owner.query(`SELECT kind, status, date_from::text FROM sync_run WHERE id = $1`, [r.syncRunId])).rows[0];
    expect(run).toEqual({ kind: "unite_calls", status: "completed", date_from: "2026-09-16" });
  });

  it("is idempotent, and matches a call once its lead's number arrives later", async () => {
    const again = await runUniteCallSync({ client: stub, startedBy: "test", now: NOW });
    expect(again.counts).toMatchObject({ calls_upserted: 3, calls_matched_now: 0 });
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM unite_call`)).rows[0].n).toBe(3);
    // The (973) lead reaches JobProgress after the call: the next run attaches it.
    await db.owner.query(`INSERT INTO jp_customer (jp_customer_id, customer_name, jp_created_at) VALUES ('9002','Joseph Lorent','2026-09-18')`);
    await db.owner.query(`INSERT INTO jp_customer_phone (jp_customer_id, phone_key) VALUES ('9002','9735550100')`);
    const third = await runUniteCallSync({ client: stub, startedBy: "test", now: NOW });
    expect(third.counts).toMatchObject({ calls_matched_now: 1, calls_unmatched_total: 0 });
    const s = await uniteMirrorStatus();
    expect(s).toMatchObject({ users: 2, calls: 3, matched: 2, customersWithCalls: 2 });
    expect(s.lastRun).toMatchObject({ status: "completed" });
  });

  it("records a failed run when Unite is unreachable or not configured", async () => {
    const broken = { listAccountContacts: async () => { throw new Error("ECONNRESET"); } } as unknown as UniteClient;
    const r = await runUniteCallSync({ client: broken, now: NOW });
    expect(r.status).toBe("failed");
    expect((await db.owner.query(`SELECT status, error_message FROM sync_run WHERE id = $1`, [r.syncRunId])).rows[0]).toEqual({ status: "failed", error_message: "ECONNRESET" });
    expect((await runUniteCallSync({ client: null, now: NOW })).errorMessage).toMatch(/not configured/);
  });
});
