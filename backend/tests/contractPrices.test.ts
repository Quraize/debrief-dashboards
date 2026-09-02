/**
 * Contract price automation: the reply parser (pure), and the scan/approve
 * flow against a real database — because the properties that matter are
 * database properties: rescans don't duplicate, approvals never overwrite an
 * existing price, and every outcome leaves an audit row.
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

/** Stub JP client: proposals per job id, plus a live financial summary map. */
function stubClient(
  proposalsByJob: Record<string, Record<string, unknown>[]>,
  financials: Record<string, Record<string, unknown>> = {},
  priceWrites: { jobId: string; amount: number }[] = [],
) {
  const impl = (async (url: string, init?: { method?: string; body?: URLSearchParams }) => {
    const u = String(url);
    let data: unknown = [];
    const finMatch = u.match(/\/jobs\/([^/?]+)\/financial_summary/);
    const priceMatch = u.match(/\/jobs\/([^/?]+)\/financials\/price/);
    if (priceMatch && init?.method === "PUT") {
      priceWrites.push({ jobId: priceMatch[1]!, amount: Number(init.body?.get("amount")) });
      data = {};
    } else if (finMatch) {
      data = [financials[finMatch[1]!] ?? {}];
    } else if (u.includes("/proposals")) {
      const jobId = new URL(u).searchParams.get("job_id") ?? "";
      data = proposalsByJob[jobId] ?? [];
    } else if (u.startsWith("https://files.test/")) {
      // downloadFile goes straight to storage — return PDF-ish bytes
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

const proposal = (id: number, over: Record<string, unknown> = {}) => ({
  id, title: "Roof replacement", customer_id: 777,
  file_name: "Roof_replacement.pdf", file_mime_type: "application/pdf",
  status: "accepted", url: `https://files.test/${id}.pdf`,
  ...over,
});

const extraction = (over: Partial<ContractExtraction> = {}): ContractExtraction => ({
  classification: "retail_contract", signed: true, amount: 15200,
  jobNumber: "L-1", confidence: "high", notes: "", model: "test-model", raw: {},
  ...over,
});

describe.skipIf(!reachable)("scanContractPrices / approveCandidate", () => {
  beforeAll(async () => {
    db = await createTestDb("prices");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;

    // Recently signed retail jobs with no price, one insurance, one priced.
    await db.owner.query(`
      INSERT INTO jp_job (jp_job_id, job_number, job_name, contract_signed_date, is_insurance, total_job_price) VALUES
      ('901', 'L-1', 'Dudina',  current_date - 2, false, NULL),
      ('902', 'L-2', 'Euler',   current_date - 1, false, NULL),
      ('903', 'L-3', 'Insured', current_date - 1, true,  NULL),
      ('904', 'L-4', 'Priced',  current_date - 1, false, 9000)`);
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

  it("proposes a pending candidate for a signed job with a readable contract", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({ "901": [proposal(11)] }),
      extract: async () => extraction(),
    });
    expect(result.jobs_scanned, "insurance and already-priced jobs are not scanned").toBe(2);
    expect(result.candidates_created).toBe(1);

    const row = await candidate("901", "11");
    expect(row).toMatchObject({ status: "pending", extracted_amount: "15200.00", confidence: "high" });
  });

  it("never examines the same proposal twice", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({ "901": [proposal(11)] }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.already_examined).toBe(1);
    expect(result.candidates_created).toBe(0);
  });

  it("skips change orders and mismatched job numbers instead of proposing them", async () => {
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({ "902": [proposal(21), proposal(22), proposal(23, { status: "draft" })] }),
      extract: async (pdf) => pdf.length > 0 && Math.random() >= 0 // deterministic per call order below
        ? extraction({ classification: "change_order", amount: 500 })
        : extraction(),
    });
    // draft proposal filtered before extraction; both accepted ones examined
    expect(result.proposals_examined).toBe(2);
    const row = await candidate("902", "21");
    expect(row!.status).toBe("skipped");
    expect(row!.extraction_notes).toContain("change_order");
  });

  it("flags a document whose JOB NAME does not match the job", async () => {
    await db.owner.query(
      `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, is_insurance) VALUES
       ('905', 'L-5', current_date - 1, false)`);
    await scanContractPrices({
      days: 5,
      client: stubClient({ "905": [proposal(51)] }),
      extract: async () => extraction({ jobNumber: "L-999" }),
    });
    const row = await candidate("905", "51");
    expect(row!.status).toBe("pending"); // still reviewable — but loudly flagged
    expect(row!.confidence).toBe("low");
    expect(row!.extraction_notes).toContain("does not match");
  });

  it("records an extraction failure as a failed audit row and keeps scanning", async () => {
    await db.owner.query(
      `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, is_insurance) VALUES
       ('906', 'L-6', current_date - 1, false)`);
    const result = await scanContractPrices({
      days: 5,
      client: stubClient({ "906": [proposal(61)] }),
      extract: async () => { throw new Error("Claude API unavailable after retries"); },
    });
    expect(result.extraction_errors).toBe(1);
    expect((await candidate("906", "61"))!.status).toBe("failed");
  });

  it("approve writes the price once and records who approved it", async () => {
    const writes: { jobId: string; amount: number }[] = [];
    const row = await candidate("901", "11");
    const out = await approveCandidate(row!.id, "admin@test",
      stubClient({}, { "901": { total_job_price: "0.00" } }, writes));
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
    await db.owner.query(
      `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, is_insurance) VALUES
       ('907', 'L-7', current_date - 1, false)`);
    await scanContractPrices({
      days: 5, client: stubClient({ "907": [proposal(71)] }),
      extract: async () => extraction({ amount: 20000 }),
    });
    const row = await candidate("907", "71");

    const writes: { jobId: string; amount: number }[] = [];
    const out = await approveCandidate(row!.id, "admin@test",
      stubClient({}, { "907": { total_job_price: "19500.00" } }, writes));
    expect(out.applied).toBe(false);
    expect(writes, "nothing may be written when a live price exists").toEqual([]);
    expect((await candidate("907", "71"))!.status).toBe("skipped");
  });

  it("leaves an audit row for a scanned job with nothing readable, without blocking later documents", async () => {
    await db.owner.query(
      `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, is_insurance) VALUES
       ('909', 'L-9', current_date - 1, false)`);

    // First scan: only a draft proposal — nothing examinable.
    let result = await scanContractPrices({
      days: 5, client: stubClient({ "909": [proposal(91, { status: "draft" })] }),
      extract: async () => { throw new Error("must not be called"); },
    });
    expect(result.details.find((d) => d.proposal_id === "none")?.outcome).toBe("no_documents");
    const auditRow = await candidate("909", "none");
    expect(auditRow!.status).toBe("skipped");
    expect(auditRow!.extraction_notes).toContain("not accepted");

    // Second scan, same state: no duplicate audit row (unique constraint).
    await scanContractPrices({
      days: 5, client: stubClient({ "909": [proposal(91, { status: "draft" })] }),
      extract: async () => { throw new Error("must not be called"); },
    });
    const { rows } = await db.owner.query(
      `SELECT count(*)::int AS n FROM jp_price_candidate WHERE jp_job_id = '909'`);
    expect(rows[0]!.n).toBe(1);

    // The document later becomes accepted: examined normally despite the audit row.
    result = await scanContractPrices({
      days: 5, client: stubClient({ "909": [proposal(91)] }),
      extract: async () => extraction({ amount: 12000 }),
    });
    expect(result.candidates_created).toBe(1);
    expect((await candidate("909", "91"))!.status).toBe("pending");
  });

  it("reject closes a pending row and refuses non-pending ones", async () => {
    await db.owner.query(
      `INSERT INTO jp_job (jp_job_id, job_number, contract_signed_date, is_insurance) VALUES
       ('908', 'L-8', current_date - 1, false)`);
    await scanContractPrices({
      days: 5, client: stubClient({ "908": [proposal(81)] }),
      extract: async () => extraction(),
    });
    const row = await candidate("908", "81");
    await rejectCandidate(row!.id, "admin@test", "wrong document");
    expect((await candidate("908", "81"))!.status).toBe("rejected");
    await expect(rejectCandidate(row!.id, "admin@test")).rejects.toMatchObject({ statusCode: 409 });
  });
});
