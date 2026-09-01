/**
 * JobProgress sync.
 *
 * Runs against a real database with a stubbed API, because the properties worth
 * asserting are database properties: idempotency, telemetry that actually gets
 * written, and the watermark advancing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { JobProgressClient } from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";
import {
  runJobProgressSync, mapAppointment, mapJpAppointment, mapJpJob, extractResultFields,
} from "../src/jobs/syncJobProgress.js";

const reachable = await pgReachable();
requirePg(reachable);

let db: TestDb;

interface StubExtras {
  /** appointment id -> GET /appointments/{id}/result payload */
  results?: Record<string, unknown>;
  /** job id -> financial summary record, or { __status } to refuse the call */
  financials?: Record<string, unknown>;
}

/** Stubbed API in the documented response shapes. URL sniffing goes from the
 *  most specific path to the least, because `/appointments/{id}/result` also
 *  contains `/appointments`. */
function stubApi(appointments: unknown[], signedJobs: unknown[] = [], extra: StubExtras = {}) {
  const impl = (async (url: string) => {
    const u = String(url);
    const resultMatch = u.match(/\/appointments\/([^/?]+)\/result/);
    const finMatch = u.match(/\/jobs\/([^/?]+)\/financial_summary/);
    let data: unknown = [];
    if (resultMatch) {
      data = extra.results?.[resultMatch[1]!] ?? [];
    } else if (finMatch) {
      const record = extra.financials?.[finMatch[1]!] as Record<string, unknown> | undefined;
      if (record?.["__status"]) {
        return {
          ok: false, status: record["__status"], headers: { get: () => null },
          json: async () => ({}),
        } as unknown as Response;
      }
      data = record ? [record] : [];
    } else if (u.includes("/divisions")) {
      data = [{ id: 7, name: "ACR Roofing Division" }];
    } else if (u.includes("/appointments")) {
      data = appointments;
    } else if (u.includes("contract_signed_date")) {
      data = signedJobs;
    } else if (u.includes("/jobs")) {
      data = [];
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ data, meta: { pagination: { total_pages: 1 } } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return new JobProgressClient({
    token: "test", baseUrl: "https://api.test/v3", fetchImpl: impl,
    limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }),
    sleep: async () => {},
  });
}

/** Includes wrapped in `.data`, exactly as the API documents them. */
const appointment = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  title: "ROOF EST",
  start_date_time: "2026-07-15T09:30:00",
  result_option_ids: [],
  jobs: { data: [{ id: 900 + id, number: `L-${id}`, division_id: 7, insurance: false }] },
  customer: { data: { name: "Smith Household", phone: "5551234567", city: "Newark" } },
  user: { data: { first_name: "Jason", last_name: "Malarchak" } },
  created_by: { data: { name: "Ashley Pasquale" } },
  ...over,
});

const signedJob = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  number: `L-${id}`,
  name: "Smith Household",
  contract_signed_date: "2026-08-05",
  insurance: false,
  division: { data: { id: 7, name: "ACR Roofing Division" } },
  trades: { data: [{ id: 1, name: "ROOFING" }] },
  ...over,
});

describe.skipIf(!reachable)("mapAppointment", () => {
  const divisions = new Map([["7", "ACR Roofing Division"]]);

  it("unwraps every included relation (docs §2.3)", () => {
    // The defect this replaces: the old client read customer/user/created_by
    // without unwrapping `.data`, so these fields imported blank.
    const row = mapAppointment(appointment(1), divisions);
    expect(row.phone).toBe("5551234567");
    expect(row.city).toBe("Newark");
    expect(row.original_sales_rep).toBe("Jason Malarchak");
    expect(row.original_appointment_setter).toBe("Ashley Pasquale");
  });

  it("splits the start timestamp into a date and a time", () => {
    const row = mapAppointment(appointment(1), divisions);
    expect(row.appointment_date).toBe("2026-07-15");
    expect(row.appointment_time).toBe("09:30");
  });

  it("resolves the division name from its id", () => {
    expect(mapAppointment(appointment(1), divisions).product).toBe("ACR Roofing Division");
  });

  it("flags insurance jobs", () => {
    const row = mapAppointment(
      appointment(1, { jobs: { data: [{ id: 1, number: "L-1", division_id: 7, insurance: true }] } }),
      divisions);
    expect(row.business_division).toBe("Insurance");
  });

  it("classifies non-sales titles using the consolidated rules", () => {
    expect(mapAppointment(appointment(1, { title: "ROOF EST" }), divisions).is_sales_appointment).toBe(true);
    expect(mapAppointment(appointment(1, { title: "WARRANTY CALLBACK" }), divisions).is_sales_appointment).toBe(false);
  });

  it("survives an appointment with no relations at all", () => {
    const row = mapAppointment({ id: 1, title: "ROOF EST", start_date_time: "2026-07-15T09:30:00" }, divisions);
    expect(row.customer_name).toBe("ROOF EST"); // falls back to the title
    expect(row.phone).toBeNull();
  });
});

describe.skipIf(!reachable)("mapJpAppointment", () => {
  const divisions = new Map([["7", "ACR Roofing Division"]]);

  it("keeps non-sales appointments, flagged rather than filtered", () => {
    const row = mapJpAppointment(appointment(1, { title: "WARRANTY CALLBACK" }), divisions);
    expect(row.is_sales_type).toBe(false);
    expect(row.jp_appointment_id).toBe("1");
  });

  it("parses the inline result's Two-Leg answer and the result group", () => {
    const row = mapJpAppointment(appointment(1, {
      result_option_ids: [13],
      result: [{ name: "Was it 2-Legs? Was it Reset?", type: "text", value: "2 legs. products showed" }],
      result_option: { data: { id: 13, name: "Demo Completed", group: { data: { id: 2, name: "Sale" } } } },
    }), divisions);
    expect(row.has_result).toBe(true);
    expect(row.two_leg_answer).toBe("two_leg");
    expect(row.two_leg_raw).toBe("2 legs. products showed");
    expect(row.result_group).toBe("Sale");
    expect(row.result_option_name).toBe("Demo Completed");
  });

  it("keeps customer PII out of the raw payload", () => {
    const row = mapJpAppointment(appointment(1), divisions);
    const raw = JSON.parse(row.raw as string);
    expect(raw.customer).toBeUndefined();
    expect(raw.jobs).toBeUndefined();
    expect(raw.title).toBe("ROOF EST");
  });
});

describe.skipIf(!reachable)("extractResultFields", () => {
  const fields = [{ name: "Was it 2-Legs?", value: "2legs" }];

  it("accepts the documented shapes without throwing on any of them", () => {
    expect(extractResultFields(fields)).toEqual(fields);
    expect(extractResultFields({ data: fields })).toEqual(fields);
    expect(extractResultFields({ fields })).toEqual(fields);
    expect(extractResultFields({ data: { fields } })).toEqual(fields);
    expect(extractResultFields(null)).toEqual([]);
    expect(extractResultFields("2legs")).toEqual([]);
    expect(extractResultFields({ unexpected: true })).toEqual([]);
  });
});

describe.skipIf(!reachable)("mapJpJob", () => {
  it("maps a signed job with division, trades and signed date", () => {
    const row = mapJpJob(signedJob(501), new Map());
    expect(row.jp_job_id).toBe("501");
    expect(row.job_number).toBe("L-501");
    expect(row.division).toBe("ACR Roofing Division");
    expect(row.trades).toBe("ROOFING");
    expect(row.contract_signed_date).toBe("2026-08-05");
    expect(row.is_insurance).toBe(false);
  });
});

describe.skipIf(!reachable)("runJobProgressSync", () => {
  beforeAll(async () => {
    db = await createTestDb("sync");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  const count = async (table: string) =>
    (await db.owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;

  const jpAppt = async (jpId: string) =>
    (await db.owner.query(`SELECT * FROM jp_appointment WHERE jp_appointment_id = $1`, [jpId])).rows[0];

  it("writes a sync_run row — the telemetry that never existed", async () => {
    // The admin UI reads sync_run for "Last Successful Commit". Nothing has ever
    // written to it, so it has always shown "Never".
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31",
      fullBackfill: true, startedBy: "test",
      client: stubApi([appointment(1), appointment(2)]),
    });
    expect(result.status).toBe("completed");
    expect(await count("sync_run")).toBe(1);

    const { rows } = await db.owner.query<{ status: string; finished_at: Date; counts: Record<string, number> }>(
      `SELECT status, finished_at, counts FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.finished_at, "finished_at drives the status bar").not.toBeNull();
    expect(rows[0]!.counts.created).toBe(2);
  });

  it("creates the appointments it examined", async () => {
    expect(await count("appointment")).toBe(2);
  });

  it("is idempotent — a second run creates nothing new", async () => {
    // The regression that mattered most: the old sync matched against a 500-row
    // window and recreated anything older on every run.
    const before = await count("appointment");
    const beforeJp = await count("jp_appointment");
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([appointment(1), appointment(2)]),
    });
    expect(await count("appointment")).toBe(before);
    expect(await count("jp_appointment"), "the mirror upserts on jp_appointment_id").toBe(beforeJp);
    expect(result.counts.created).toBe(0);
    expect(result.counts.updated).toBe(2);
  });

  it("writes nothing in dry_run mode", async () => {
    const before = await count("appointment");
    const beforeJp = await count("jp_appointment");
    const result = await runJobProgressSync({
      mode: "dry_run", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([appointment(3), appointment(4)]),
    });
    expect(await count("appointment")).toBe(before);
    expect(await count("jp_appointment"), "dry_run must not touch the mirror either").toBe(beforeJp);
    expect(result.counts.proposed_new_appointments).toBe(2);
    expect(result.counts.created).toBe(0);
  });

  it("excludes non-sales appointments from the operational table but mirrors them", async () => {
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([appointment(5, { title: "WARRANTY CALLBACK" }), appointment(6)]),
    });
    expect(result.counts.non_sales_exclusions).toBe(1);
    expect(result.counts.created).toBe(1);
    // The blind spot this feature exists to expose: the CRM saw the warranty
    // visit even though the debrief pipeline rightly ignores it.
    const mirrored = await jpAppt("5");
    expect(mirrored).toBeDefined();
    expect(mirrored!.is_sales_type).toBe(false);
  });

  it("records a conflict when identity cannot be established", async () => {
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([appointment(7, { start_date_time: "" })]),
    });
    expect(result.counts.conflicts).toBe(1);
    const { rows } = await db.owner.query<{ category: string }>(
      `SELECT category FROM sync_conflict WHERE sync_run_id = $1`, [result.syncRunId]);
    expect(rows[0]!.category).toBe("missing_data");
  });

  it("counts appointments with and without results using the plural field", async () => {
    const result = await runJobProgressSync({
      mode: "dry_run", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([
        appointment(8, { result_option_ids: [13] }),
        appointment(9, { result_option_ids: [] }),
      ]),
    });
    expect(result.counts.appointment_results_available).toBe(1);
    expect(result.counts.appointment_results_missing).toBe(1);
  });

  it("stores the Two-Leg answer parsed from the inline result", async () => {
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi([appointment(10, {
        result_option_ids: [13],
        result: [{ name: "Was it 2-Legs? Was it Reset?", type: "text", value: "2legs/$22199" }],
        result_option: { data: { id: 13, name: "Demo Completed", group: { data: { id: 2, name: "Sale" } } } },
      })]),
    });
    expect(result.counts.jp_two_leg_answers).toBe(1);
    expect(result.counts.jp_results_fetched, "the inline result must not cost an extra call").toBe(0);
    const row = await jpAppt("10");
    expect(row!.two_leg_answer).toBe("two_leg");
    expect(row!.result_group).toBe("Sale");
  });

  it("fetches the result form only when the listing omits the fields", async () => {
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true,
      client: stubApi(
        [appointment(11, { result_option_ids: [14], result: [] })],
        [],
        { results: { "11": { data: [{ name: "Was it 2-Legs?", type: "text", value: "1 leg" }] } } },
      ),
    });
    expect(result.counts.jp_results_fetched).toBe(1);
    const row = await jpAppt("11");
    expect(row!.two_leg_answer).toBe("one_leg");
    expect(row!.two_leg_raw).toBe("1 leg");
  });

  it("stores signed jobs with their financial summaries", async () => {
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-08-01", dateTo: "2026-08-31", fullBackfill: true,
      client: stubApi([], [signedJob(501)], {
        financials: { "501": { total_job_revenue: "32990", total_job_price: "30000", total_change_order_amount: "2990" } },
      }),
    });
    expect(result.counts.signed_sales_found).toBe(1);
    expect(result.counts.jp_jobs_upserted).toBe(1);
    expect(result.counts.revenue_total).toBe(32990);
    const { rows } = await db.owner.query(
      `SELECT * FROM jp_job WHERE jp_job_id = '501'`);
    expect(rows[0]!.total_job_revenue).toBe("32990.00"); // NUMERIC comes back as string by design
    expect(rows[0]!.contract_signed_date).toBe("2026-08-05");
  });

  it("counts a refused financial summary instead of failing the run", async () => {
    // The API 412s on some jobs' financial summaries — observed live in August.
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-08-01", dateTo: "2026-08-31", fullBackfill: true,
      client: stubApi([], [signedJob(502)], { financials: { "502": { __status: 412 } } }),
    });
    expect(result.status).toBe("completed");
    expect(result.counts.financial_summary_errors).toBe(1);
    const { rows } = await db.owner.query(
      `SELECT total_job_revenue FROM jp_job WHERE jp_job_id = '502'`);
    expect(rows[0]!.total_job_revenue, "missing financials stay NULL, never zero").toBeNull();
    const conflict = await db.owner.query<{ category: string; crm_job_id: string }>(
      `SELECT category, crm_job_id FROM sync_conflict WHERE sync_run_id = $1`, [result.syncRunId]);
    expect(conflict.rows[0]!.category).toBe("api_error");
    expect(conflict.rows[0]!.crm_job_id).toBe("502");
  });

  it("records a failed run instead of vanishing silently", async () => {
    const failing = new JobProgressClient({
      token: "t", baseUrl: "https://api.test/v3",
      fetchImpl: (async () => { throw new Error("upstream exploded"); }) as unknown as typeof fetch,
      limiter: new RateLimiter({ limit: 1e9, windowMs: 1, sleep: async () => {} }),
      sleep: async () => {},
    });
    const result = await runJobProgressSync({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-07-31", fullBackfill: true, client: failing });

    expect(result.status).toBe("failed");
    expect(result.errorMessage).toMatch(/upstream exploded/);
    const { rows } = await db.owner.query<{ status: string; error_message: string }>(
      `SELECT status, error_message FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.error_message).toContain("upstream exploded");
  });

  it("picks up the watermark from the last successful commit", async () => {
    // Proves the incremental path is wired: with a prior successful run present
    // and fullBackfill off, the run records where it resumed from.
    const result = await runJobProgressSync({
      mode: "commit", client: stubApi([appointment(20)]),
    });
    expect(result.incrementalSince, "should resume from the previous run").not.toBeNull();

    const { rows } = await db.owner.query<{ incremental_since: Date | null }>(
      `SELECT incremental_since FROM sync_run WHERE id = $1`, [result.syncRunId]);
    expect(rows[0]!.incremental_since, "the field the schema has always had and nothing wrote").not.toBeNull();
  });

  it("counts signed sales from the direct query", async () => {
    const result = await runJobProgressSync({
      mode: "dry_run", dateFrom: "2026-08-01", dateTo: "2026-08-31", fullBackfill: true,
      client: stubApi([], [{ id: 1 }, { id: 2 }, { id: 3 }]),
    });
    expect(result.counts.signed_sales_found).toBe(3);
  });
});
