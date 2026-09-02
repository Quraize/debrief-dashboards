/**
 * Contract price automation: the reply parser (pure), and the scan/approve
 * flow against a real database — because the properties that matter are
 * database properties: rescans don't duplicate, approvals never overwrite an
 * existing price, and every outcome leaves an audit row.
 *
 * Discovery is proposal-driven: recently ACCEPTED documents across all jobs,
 * because Leap only sets contract_signed_date for digitally signed worksheets
 * (auto-filling their price with it) — the jobs that need manual price entry
 * are scanned uploads, which never get a signed date.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { parseExtractionReply, type ContractExtraction } from "../src/integrations/anthropic/contractExtractor.js";
import { scanContractPrices, approveCandidate, rejectCandidate } from "../src/jobs/contractPrices.js";
import { JobProgressClient } from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";

const reachable = await pgReachable();
requirePg(reachable);

let db: TestDb;

describe("parseExtractionReply", () => {
  it("parses a clean reply", () => {
    const out = parseExtractionReply(
      `{"classification":"retail_contract","signed":true,"amount":15200,"job_number":"2608-8961835-01","confidence":"high","notes":""}`);
    expect(out).toMatchObject({ classification: "retail_contract", amount: 15200, signed: true });
  });

  it("tolerates code fences and surrounding prose", () => {
    const out = parseExtractionReply(
      "Here you go:\n```json\n{\"classification\":\"change_order\",\"signed\":false,\"amount\":500,\"job_number\":null,\"confidence\":\"low\",\"notes\":\"x\"}\n```");
    expect(out?.classification).toBe("change_order");
  });

  it("rejects garbage rather than guessing", () => {
    expect(parseExtractionReply("I could not read the document")).toBeNull();
    expect(parseExtractionReply(`{"classification":"invoice"}`)).toBeNull();
  });

  it("discards non-positive or non-numeric amounts", () => {
    const out = parseExtractionReply(
      `{"classification":"retail_contract","signed":true,"amount":-5,"job_number":null,"confidence":"high","notes":""}`);
    expect(out?.amount).toBeNull();
  });
});

interface StubConfig {
  /** the global recent-proposals listing (one page) */
  proposals?: Record<string, unknown>[];
  /** job metadata returned for job_ids[] batches */
  jobs?: Record<string, unknown>[];
  /** job id -> live financial summary */
  financials?: Record<string, Record<string, unknown>>;
  priceWrites?: { jobId: string; amount: number }[];
}

function stubClient(cfg: StubConfig = {}) {
  const impl = (async (url: string, init?: { method?: string; body?: URLSearchParams }) => {
    const u = String(url);
    let data: unknown = [];
    const finMatch = u.match(/\/jobs\/([^/?]+)\/financial_summary/);
    const priceMatch = u.match(/\/jobs\/([^/?]+)\/financials\/price/);
    if (priceMatch && init?.method === "PUT") {
      cfg.priceWrites?.push({ jobId: priceMatch[1]!, amount: Number(init.body?.get("amount")) });
      data = {};
    } else if (finMatch) {
      data = [cfg.financials?.[finMatch[1]!] ?? {}];
    } else if (u.includes("job_ids")) {
      data = cfg.jobs ?? [];
    } else if (u.includes("/proposals")) {
      data = cfg.proposals ?? [];
    } else if (u.startsWith("https://files.test/")) {
      return {
        ok: true, status: 200,
        headers: { get: () => "application/pdf" },
        arrayBuffer: async () => new TextEncoder().encode("%PDF-fake").buffer,
      } as unknown as Response;
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

const NOW_STAMP = new Date().toISOString().slice(0, 19).replace("T", " ");

const proposal = (id: number, jobId: string, over: Record<string, unknown> = {}) => ({
  id, job_id: Number(jobId), customer_id: 777,
  title: "Roof replacement", file_name: "Roof_replacement.pdf",
  file_mime_type: "application/pdf", status: "accepted",
  url: `https://files.test/${id}.pdf`,
  created_at: NOW_STAMP, updated_at: NOW_STAMP,
  ...over,
});

const jobMeta = (id: string, over: Record<string, unknown> = {}) => ({
  id: Number(id), number: `L-${id}`, name: `Job ${id}`, insurance: false, ...over,
});

const extraction = (over: Partial<ContractExtraction> = {}): ContractExtraction => ({
  classification: "retail_contract", signed: true, amount: 15200,
  jobNumber: "L-901", confidence: "high", notes: "", model: "test-model", raw: {},
  ...over,
});

describe.skipIf(!reachable)("scanContractPrices / approveCandidate", () => {
  beforeAll(async () => {
    db = await createTestDb("prices");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;

    // Mirror row for the approve test's mirror-update assertion only —
    // discovery itself never touches the mirror anymore.
    await db.owner.query(`
      INSERT INTO jp_job (jp_job_id, job_number, job_name, is_insurance) VALUES
      ('901', 'L-901', 'Dudina', false)`);
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  const candidate = async (jobId: string, proposalId: string) =>
    (await db.owner.query(
      `SELECT * FROM jp_price_candidate WHERE jp_job_id = $1 AND proposal_id = $2`,
      [jobId, proposalId])).rows[0];

  it("proposes a pending candidate for an accepted contract on an unpriced job", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(11, "901")],
        jobs: [jobMeta("901")],
        financials: { "901": { total_job_price: "0.00" } },
      }),
      extract: async () => extraction(),
    });
    expect(result.jobs_scanned).toBe(1);
    expect(result.candidates_created).toBe(1);
    const row = await candidate("901", "11");
    expect(row).toMatchObject({
      status: "pending", extracted_amount: "15200.00", confidence: "high", job_number: "L-901",
    });
  });

  it("never examines the same document twice", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(11, "901")],
        jobs: [jobMeta("901")],
        financials: { "901": { total_job_price: "0.00" } },
      }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.already_examined).toBe(1);
    expect(result.candidates_created).toBe(0);
  });

  it("ignores non-accepted and non-PDF documents entirely", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [
          proposal(21, "902", { status: "draft" }),
          proposal(22, "902", { file_mime_type: "image/png" }),
        ],
        jobs: [jobMeta("902")],
      }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.jobs_scanned, "no accepted PDFs means the job never enters the scan").toBe(0);
  });

  it("ignores proposals accepted before the look-back window", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(31, "903", { created_at: "2026-01-01 09:00:00", updated_at: "2026-01-01 09:00:00" })],
        jobs: [jobMeta("903")],
      }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.jobs_scanned).toBe(0);
  });

  it("audits insurance jobs as skipped without reading their documents", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(41, "904")],
        jobs: [jobMeta("904", { insurance: true })],
      }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.details[0]).toMatchObject({ proposal_id: "41", outcome: "insurance" });
    expect((await candidate("904", "41"))!.status).toBe("skipped");
  });

  it("audits already-priced jobs as skipped without reading their documents", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(51, "905")],
        jobs: [jobMeta("905")],
        financials: { "905": { total_job_price: "19500.00" } },
      }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.details[0]).toMatchObject({ proposal_id: "51", outcome: "already_priced" });
    const row = await candidate("905", "51");
    expect(row!.status).toBe("skipped");
    expect(row!.extraction_notes).toContain("already set");
  });

  it("skips change orders and flags job-number mismatches", async () => {
    await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(61, "906", { title: "Change Order" })],
        jobs: [jobMeta("906")],
        financials: { "906": { total_job_price: "0.00" } },
      }),
      extract: async () => extraction({ classification: "change_order", amount: 500 }),
    });
    expect((await candidate("906", "61"))!.status).toBe("skipped");

    await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(71, "907")],
        jobs: [jobMeta("907")],
        financials: { "907": { total_job_price: "0.00" } },
      }),
      extract: async () => extraction({ jobNumber: "L-999" }),
    });
    const row = await candidate("907", "71");
    expect(row!.status).toBe("pending"); // still reviewable — but loudly flagged
    expect(row!.confidence).toBe("low");
    expect(row!.extraction_notes).toContain("does not match");
  });

  it("records an extraction failure as a failed audit row and keeps scanning", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(81, "908")],
        jobs: [jobMeta("908")],
        financials: { "908": { total_job_price: "0.00" } },
      }),
      extract: async () => { throw new Error("Claude API unavailable after retries"); },
    });
    expect(result.extraction_errors).toBe(1);
    expect((await candidate("908", "81"))!.status).toBe("failed");
  });

  it("approve writes the price once and records who approved it", async () => {
    const writes: { jobId: string; amount: number }[] = [];
    const row = await candidate("901", "11");
    const out = await approveCandidate(row!.id, "admin@test",
      stubClient({ financials: { "901": { total_job_price: "0.00" } }, priceWrites: writes }));
    expect(out).toMatchObject({ applied: true, amount: 15200 });
    expect(writes).toEqual([{ jobId: "901", amount: 15200 }]);

    const after = await candidate("901", "11");
    expect(after).toMatchObject({ status: "applied", reviewed_by: "admin@test" });
    const mirror = await db.owner.query(`SELECT total_job_price FROM jp_job WHERE jp_job_id = '901'`);
    expect(mirror.rows[0]!.total_job_price, "mirror updated immediately").toBe("15200.00");

    // Second approve must refuse — the row is no longer pending.
    await expect(approveCandidate(row!.id, "admin@test", stubClient({})))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("refuses to overwrite a price that appeared since the scan", async () => {
    await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(91, "909")],
        jobs: [jobMeta("909")],
        financials: { "909": { total_job_price: "0.00" } },
      }),
      extract: async () => extraction({ amount: 20000 }),
    });
    const row = await candidate("909", "91");

    const writes: { jobId: string; amount: number }[] = [];
    const out = await approveCandidate(row!.id, "admin@test",
      stubClient({ financials: { "909": { total_job_price: "19500.00" } }, priceWrites: writes }));
    expect(out.applied).toBe(false);
    expect(writes, "nothing may be written when a live price exists").toEqual([]);
    expect((await candidate("909", "91"))!.status).toBe("skipped");
  });

  it("reject closes a pending row and refuses non-pending ones", async () => {
    await scanContractPrices({
      days: 5,
      client: stubClient({
        proposals: [proposal(101, "910")],
        jobs: [jobMeta("910")],
        financials: { "910": { total_job_price: "0.00" } },
      }),
      extract: async () => extraction(),
    });
    const row = await candidate("910", "101");
    await rejectCandidate(row!.id, "admin@test", "wrong document");
    expect((await candidate("910", "101"))!.status).toBe("rejected");
    await expect(rejectCandidate(row!.id, "admin@test")).rejects.toMatchObject({ statusCode: 409 });
  });
});
