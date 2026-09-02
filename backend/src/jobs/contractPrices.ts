/**
 * Contract price automation — Stage 1 (human-in-the-loop).
 *
 * scanContractPrices: recently signed retail jobs with no Job Price → fetch
 * their accepted proposal PDFs → Claude classifies and extracts the total →
 * one jp_price_candidate row per (job, proposal). The scan proposes; it never
 * writes to JobProgress.
 *
 * approveCandidate: the admin's click. Re-checks the LIVE financial summary
 * first — if a price appeared since the scan (someone did it manually), the
 * candidate is closed as skipped rather than overwriting. Only then does the
 * price go to JobProgress, and the row records who approved it and when.
 *
 * Everything here is idempotent: rescans skip examined proposals (unique
 * constraint), and an approve on an already-applied row is a no-op error.
 */
import { withServiceRole } from "../db/client.js";
import { JobProgressClient, unwrap } from "../integrations/jobprogress/client.js";
import { extractContractPrice, type ContractExtraction } from "../integrations/anthropic/contractExtractor.js";

export interface ScanOptions {
  /** Look-back window over contract_signed_date. */
  days?: number;
  startedBy?: string;
  client?: JobProgressClient;
  extract?: typeof extractContractPrice;
}

export interface ScanResult {
  jobs_scanned: number;
  proposals_examined: number;
  candidates_created: number;
  already_examined: number;
  extraction_errors: number;
  details: { job_number: string | null; proposal_id: string; outcome: string }[];
}

/** The single most important guard: an amount that cannot be a real contract. */
const MIN_PLAUSIBLE = 100;
const MAX_PLAUSIBLE = 500_000;

interface CandidateJob {
  jp_job_id: string;
  job_number: string | null;
  job_name: string | null;
  contract_signed_date: string | null;
}

async function findCandidateJobs(days: number): Promise<CandidateJob[]> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<CandidateJob>(
      `SELECT jp_job_id, job_number, job_name, contract_signed_date::text
         FROM jp_job
        WHERE contract_signed_date >= current_date - $1::int
          AND is_insurance = false
          AND coalesce(total_job_price, 0) = 0`,
      [days]);
    return rows;
  }, "price-scan:candidates", { quiet: true });
}

async function proposalAlreadyExamined(jpJobId: string, proposalId: string): Promise<boolean> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query(
      `SELECT 1 FROM jp_price_candidate WHERE jp_job_id = $1 AND proposal_id = $2`,
      [jpJobId, proposalId]);
    return rows.length > 0;
  }, "price-scan:examined-check", { quiet: true });
}

async function insertCandidate(row: Record<string, unknown>): Promise<void> {
  await withServiceRole(async (c) => {
    const columns = Object.keys(row);
    await c.query(
      `INSERT INTO jp_price_candidate (${columns.map((col) => `"${col}"`).join(", ")})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT (jp_job_id, proposal_id) DO NOTHING`,
      columns.map((col) => row[col]));
  }, "price-scan:insert", { quiet: true });
}

/** pending only when everything lines up; otherwise an audit row explaining why. */
function candidateStatus(
  extraction: ContractExtraction, jobNumber: string | null,
): { status: "pending" | "skipped"; notes: string[] } {
  const notes: string[] = extraction.notes ? [extraction.notes] : [];
  if (extraction.classification !== "retail_contract") {
    notes.push(`not actionable: classified as ${extraction.classification}`);
    return { status: "skipped", notes };
  }
  if (extraction.amount == null) {
    notes.push("no contract total found");
    return { status: "skipped", notes };
  }
  if (extraction.amount < MIN_PLAUSIBLE || extraction.amount > MAX_PLAUSIBLE) {
    notes.push(`amount ${extraction.amount} outside plausible range ${MIN_PLAUSIBLE}–${MAX_PLAUSIBLE}`);
    return { status: "skipped", notes };
  }
  if (!extraction.signed) notes.push("no client signature detected — verify in the document");
  if (jobNumber && extraction.jobNumber && extraction.jobNumber !== jobNumber) {
    notes.push(`JOB NAME on document (${extraction.jobNumber}) does not match this job (${jobNumber})`);
  }
  return { status: "pending", notes };
}

export async function scanContractPrices(options: ScanOptions = {}): Promise<ScanResult> {
  const days = options.days ?? Number(process.env.PRICE_SCAN_DAYS ?? 5);
  const client = options.client ?? new JobProgressClient();
  const extract = options.extract ?? extractContractPrice;

  const result: ScanResult = {
    jobs_scanned: 0, proposals_examined: 0, candidates_created: 0,
    already_examined: 0, extraction_errors: 0, details: [],
  };

  const jobs = await findCandidateJobs(days);
  for (const job of jobs) {
    result.jobs_scanned++;
    const proposals = await client.listProposals(job.jp_job_id);
    let examinable = 0;
    let notAccepted = 0;
    let notPdf = 0;

    for (const proposal of proposals) {
      const proposalId = String(proposal["id"] ?? "");
      if (!proposalId) continue;
      // The user's rule, verified on real data: only accepted documents count.
      if (String(proposal["status"] ?? "") !== "accepted") { notAccepted++; continue; }
      if (String(proposal["file_mime_type"] ?? "") !== "application/pdf") { notPdf++; continue; }
      examinable++;

      if (await proposalAlreadyExamined(job.jp_job_id, proposalId)) {
        result.already_examined++;
        continue;
      }
      result.proposals_examined++;

      const base: Record<string, unknown> = {
        jp_job_id: job.jp_job_id,
        job_number: job.job_number,
        job_name: job.job_name,
        customer_id: proposal["customer_id"] != null ? String(proposal["customer_id"]) : null,
        contract_signed_date: job.contract_signed_date,
        proposal_id: proposalId,
        proposal_title: (proposal["title"] as string) ?? null,
        proposal_file_name: (proposal["file_name"] as string) ?? null,
        proposal_status: (proposal["status"] as string) ?? null,
      };

      try {
        const file = await client.downloadFile(String(proposal["url"]));
        const extraction = await extract(file.data);
        const { status, notes } = candidateStatus(extraction, job.job_number);
        await insertCandidate({
          ...base,
          classification: extraction.classification,
          extracted_amount: extraction.amount,
          extracted_job_number: extraction.jobNumber,
          confidence: notes.length > (extraction.notes ? 1 : 0) ? "low" : extraction.confidence,
          extraction_notes: notes.join("; ") || null,
          model: extraction.model,
          status,
          raw: JSON.stringify({ proposal: { ...proposal, url: undefined, thumb: undefined } }),
        });
        result.candidates_created++;
        result.details.push({ job_number: job.job_number, proposal_id: proposalId, outcome: status });
      } catch (err) {
        result.extraction_errors++;
        await insertCandidate({
          ...base,
          classification: "unreadable",
          extraction_notes: `extraction failed: ${(err as Error).message}`.slice(0, 400),
          status: "failed",
          raw: "{}",
        });
        result.details.push({ job_number: job.job_number, proposal_id: proposalId, outcome: "failed" });
      }
    }

    // Audit visibility: a scanned job with nothing readable still leaves a row,
    // so the review tab shows everything the automation looked at — not just
    // what it could act on. The 'none' sentinel never collides with a real
    // proposal id, so a document added later is still examined normally.
    if (examinable === 0) {
      const parts = [`scanned: no accepted PDF documents on this job`];
      if (notAccepted > 0) parts.push(`${notAccepted} proposal(s) not accepted`);
      if (notPdf > 0) parts.push(`${notPdf} accepted non-PDF file(s)`);
      if (proposals.length === 0) parts.push("no proposals at all");
      await insertCandidate({
        jp_job_id: job.jp_job_id,
        job_number: job.job_number,
        job_name: job.job_name,
        contract_signed_date: job.contract_signed_date,
        proposal_id: "none",
        status: "skipped",
        extraction_notes: parts.join("; "),
        raw: "{}",
      });
      result.details.push({ job_number: job.job_number, proposal_id: "none", outcome: "no_documents" });
    }
  }
  console.info(
    `[price-scan] ${result.jobs_scanned} job(s), ${result.proposals_examined} proposal(s) examined, `
    + `${result.candidates_created} candidate(s), ${result.extraction_errors} error(s)`);
  return result;
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

export async function approveCandidate(
  candidateId: string, actor: string, client?: JobProgressClient,
): Promise<{ applied: boolean; amount: number; reason?: string }> {
  const row = await withServiceRole(async (c) => {
    const { rows } = await c.query<{
      id: string; jp_job_id: string; status: string; extracted_amount: string | null;
    }>(`SELECT id, jp_job_id, status, extracted_amount FROM jp_price_candidate WHERE id = $1`,
      [candidateId]);
    return rows[0] ?? null;
  }, "price-approve:load", { quiet: true });

  if (!row) throw httpError("Candidate not found", 404);
  if (row.status !== "pending") throw httpError(`Candidate is ${row.status}, not pending`, 409);
  const amount = Number(row.extracted_amount);
  if (!Number.isFinite(amount) || amount <= 0) throw httpError("Candidate has no valid amount", 409);

  const jp = client ?? new JobProgressClient();

  // The overwrite guard: someone may have set the price since the scan. The
  // LIVE summary decides, not our mirror.
  const summary = await jp.financialSummary(row.jp_job_id);
  const existing = Number(unwrap<Record<string, unknown>>(summary)?.["total_job_price"] ?? summary?.["total_job_price"] ?? 0);
  if (Number.isFinite(existing) && existing > 0) {
    await closeCandidate(candidateId, "skipped", actor, `price already set in JobProgress ($${existing})`);
    return { applied: false, amount, reason: `Job already has a price ($${existing}) — nothing written.` };
  }

  try {
    await jp.updateJobPrice(row.jp_job_id, amount);
  } catch (err) {
    const message = (err as Error).message.slice(0, 400);
    await withServiceRole(async (c) => {
      await c.query(
        `UPDATE jp_price_candidate SET apply_error = $2 WHERE id = $1`,
        [candidateId, message]);
    }, "price-approve:error", { quiet: true });
    throw httpError(`JobProgress rejected the price update: ${message}`, 502);
  }

  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE jp_price_candidate
          SET status = 'applied', reviewed_by = $2, reviewed_at = now(), applied_at = now(), apply_error = NULL
        WHERE id = $1`,
      [candidateId, actor]);
    // Keep the mirror honest immediately rather than waiting for the next sync.
    await c.query(
      `UPDATE jp_job SET total_job_price = $2, financials_fetched_at = now()
        WHERE jp_job_id = (SELECT jp_job_id FROM jp_price_candidate WHERE id = $1)`,
      [candidateId, amount]);
  }, "price-approve:apply");

  console.info(`[price-approve] candidate ${candidateId}: $${amount} applied by ${actor}`);
  return { applied: true, amount };
}

export async function rejectCandidate(candidateId: string, actor: string, reason?: string): Promise<void> {
  const updated = await withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE jp_price_candidate
          SET status = 'rejected', reviewed_by = $2, reviewed_at = now(),
              extraction_notes = coalesce(nullif($3, ''), extraction_notes)
        WHERE id = $1 AND status = 'pending'`,
      [candidateId, actor, reason ?? ""]);
    return rowCount ?? 0;
  }, "price-reject");
  if (updated === 0) throw httpError("Candidate not found or not pending", 409);
}

async function closeCandidate(id: string, status: string, actor: string, note: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE jp_price_candidate
          SET status = $2, reviewed_by = $3, reviewed_at = now(),
              extraction_notes = coalesce(extraction_notes || '; ', '') || $4
        WHERE id = $1`,
      [id, status, actor, note]);
  }, "price-close", { quiet: true });
}
