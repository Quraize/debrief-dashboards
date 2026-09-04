/**
 * Customer (lead) + referral sync: the mapper (pure) and the database
 * properties — idempotent upserts, the debrief dropdown kept in step with the
 * CRM's referral list without duplicating existing values, and telemetry.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { JobProgressClient } from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";
import { mapCustomer, hasNoSource, runCustomerSync } from "../src/jobs/syncCustomers.js";

const reachable = await pgReachable();
requirePg(reachable);

// Shapes as the API returned them on 2026-09-04 (names changed).
const apiCustomer = (over: Record<string, unknown> = {}) => ({
  id: 9001, first_name: "George", last_name: "Golab", company_name: "", is_commercial: 0,
  referred_by_type: "referral", referred_by_id: 34041, referred_by_note: "", referred_by_customer_id: null,
  referred_by: { id: 34041, name: "Networx Direct Calls" },
  call_center_rep_type: "user", call_center_rep: "", canvasser_type: "", canvasser: "",
  address: { id: 1, address: "29 Carter Road", city: "West Orange", state: { id: 30, code: "NJ" }, zip: "07052" },
  created_at: "2026-08-30 14:02:11", updated_at: "2026-09-02 09:15:40",
  ...over,
});

describe("mapCustomer", () => {
  it("flattens the referral source, address and dates", () => {
    const row = mapCustomer(apiCustomer())!;
    expect(row).toMatchObject({
      jp_customer_id: "9001", customer_name: "George Golab", is_commercial: false,
      referred_by_type: "referral", referred_by_id: "34041", referred_by_name: "Networx Direct Calls",
      city: "West Orange", state: "NJ", zip: "07052", call_center_rep: null,
    });
    expect(row.jp_created_at?.toISOString()).toBe("2026-08-30T14:02:11.000Z");
    expect(hasNoSource(row)).toBe(false);
  });

  it("handles existing-customer referrals, notes, trailing spaces, and objects for reps", () => {
    const viaCustomer = mapCustomer(apiCustomer({ referred_by: null, referred_by_type: "customer", referred_by_customer_id: 77 }))!;
    expect(viaCustomer).toMatchObject({ referred_by_name: null, referred_by_type: "customer", referred_by_customer_id: "77" });
    expect(hasNoSource(viaCustomer)).toBe(false);

    const noted = mapCustomer(apiCustomer({ referred_by: null, referred_by_type: "", referred_by_note: "referred by Steve" }))!;
    expect(hasNoSource(noted)).toBe(false);

    const blank = mapCustomer(apiCustomer({ referred_by: null, referred_by_type: "", referred_by_note: "" }))!;
    expect(hasNoSource(blank)).toBe(true);

    const spaced = mapCustomer(apiCustomer({ referred_by: { id: 85503, name: "Home Avengers " },
      call_center_rep: { id: 5, first_name: "Ashley", last_name: "K" } }))!;
    expect(spaced.referred_by_name).toBe("Home Avengers");
    expect(spaced.call_center_rep).toBe("Ashley K");
    expect(mapCustomer({ first_name: "no id" })).toBeNull();
  });
});

interface Stub { referrals: Record<string, unknown>[]; customers: Record<string, unknown>[]; calls: string[] }
function stubClient(stub: Stub) {
  const impl = (async (url: string) => {
    const u = String(url);
    let data: unknown = [];
    if (u.includes("/referrals")) { stub.calls.push("referrals"); data = stub.referrals; }
    else if (u.includes("/customers")) { stub.calls.push("customers"); data = stub.customers; }
    return { ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data, meta: { pagination: { total_pages: 1 } } }) } as unknown as Response;
  }) as unknown as typeof fetch;
  return new JobProgressClient({
    token: "test", baseUrl: "https://api.test/v3", fetchImpl: impl,
    limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }), sleep: async () => {},
  });
}

let db: TestDb;

describe.skipIf(!reachable)("runCustomerSync", () => {
  const stub: Stub = {
    referrals: [
      { id: 34041, name: "Networx Direct Calls", created_at: "2022-08-12 15:30:36", updated_at: "2025-05-21 19:13:17" },
      { id: 50949, name: "Bing Paid - WR ", created_at: "2024-03-25 13:59:58", updated_at: "2025-05-13 20:55:24" },
      { id: 85503, name: "Home Avengers ", created_at: "2026-09-02 21:03:17", updated_at: "2026-09-02 21:03:17" },
    ],
    customers: [
      apiCustomer(),
      apiCustomer({ id: 9002, first_name: "Joseph", last_name: "Lorent", referred_by: null, referred_by_type: "", referred_by_note: "" }),
    ],
    calls: [],
  };

  beforeAll(async () => {
    db = await createTestDb("customers");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    // The dropdown already knows one source (with different spacing) — it must not be duplicated.
    await db.owner.query(`INSERT INTO list_option (category, value) VALUES ('marketing_source', 'Bing Paid - WR')`);
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  it("mirrors referrals and customers, and adds only the missing dropdown values", async () => {
    const result = await runCustomerSync({ client: stubClient(stub), startedBy: "test" });
    expect(result.status).toBe("completed");
    expect(result.counts).toMatchObject({
      referrals_examined: 3, referrals_upserted: 3, marketing_sources_added: 2, // Networx + Home Avengers; Bing already there
      customers_examined: 2, customers_created: 2, customers_updated: 0, customers_without_source: 1,
    });
    const opts = await db.owner.query(`SELECT value, created_by FROM list_option WHERE category = 'marketing_source' ORDER BY value`);
    expect(opts.rows.map((r) => r.value)).toEqual(["Bing Paid - WR", "Home Avengers", "Networx Direct Calls"]);
    expect(opts.rows.find((r) => r.value === "Home Avengers")?.created_by).toBe("jobprogress-sync");
    const run = await db.owner.query(`SELECT kind, status FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(run.rows[0]).toEqual({ kind: "customers", status: "completed" });
  });

  it("is idempotent", async () => {
    const result = await runCustomerSync({ client: stubClient(stub), startedBy: "test" });
    expect(result.counts).toMatchObject({ customers_created: 0, customers_updated: 2, marketing_sources_added: 0 });
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM jp_customer`)).rows[0].n).toBe(2);
    expect((await db.owner.query(`SELECT count(*)::int AS n FROM list_option WHERE category = 'marketing_source'`)).rows[0].n).toBe(3);
  });

  it("records a failed run when the API is down", async () => {
    const broken = new JobProgressClient({
      token: "test", baseUrl: "https://api.test/v3",
      fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch,
      limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }), sleep: async () => {},
    });
    const result = await runCustomerSync({ client: broken, startedBy: "test" });
    expect(result.status).toBe("failed");
    expect((await db.owner.query(`SELECT status FROM sync_run WHERE id = $1`, [result.syncRunId])).rows[0].status).toBe("failed");
  });
});
