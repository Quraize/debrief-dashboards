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

  // Discovery starts from the actual trigger event — a document ACCEPTED in the
  // window — not from the job's contract_signed_date. Leap only sets that date
  // for digitally signed worksheets (and auto-fills their price with it); the
  // jobs that genuinely need manual price entry are scanned-upload contracts,
  // which carry no signed date and were invisible to a signed-date scan.
  const sinceIso = new Date(Date.now() - days * 86_400_000)
    .toISOString().slice(0, 19).replace("T", " ");
  const recent = (await client.listRecentProposals(sinceIso)).filter((p) =>
    p["id"] != null && p["job_id"] != null
    && String(p["status"] ?? "") === "accepted"
    && String(p["file_mime_type"] ?? "") === "application/pdf");

  const byJob = new Map<string, Record<string, unknown>[]>();
  for (const p of recent) {
    const jobId = String(p["job_id"]);
    (byJob.get(jobId) ?? byJob.set(jobId, []).get(jobId)!).push(p);
  }

  // One batched call for job metadata: insurance flag, number, name, signed date.
  const metaById = new Map<string, Record<string, unknown>>();
  for (const j of await client.listJobsByIds([...byJob.keys()])) {
    if (j["id"] != null) metaById.set(String(j["id"]), j);
  }

  for (const [jobId, proposals] of byJob) {
    result.jobs_scanned++;
    const meta = metaById.get(jobId);
    const jobNumber = meta?.["number"] != null ? String(meta["number"]) : null;
    const baseJob = {
      jp_job_id: jobId,
      job_number: jobNumber,
      job_name: (meta?.["name"] as string) ?? null,
      contract_signed_date: meta?.["contract_signed_date"]
        ? String(meta["contract_signed_date"]).slice(0, 10) : null,
    };
    const auditRow = (proposal: Record<string, unknown>, extra: Record<string, unknown>) => ({
      ...baseJob,
      customer_id: proposal["customer_id"] != null ? String(proposal["customer_id"]) : null,
      proposal_id: String(proposal["id"]),
      proposal_title: (proposal["title"] as string) ?? null,
      proposal_file_name: (proposal["file_name"] as string) ?? null,
      proposal_status: (proposal["status"] as string) ?? null,
      ...extra,
    });

    // Insurance jobs are out of scope by the business rule — audited, not read.
    if (meta?.["insurance"]) {
      for (const proposal of proposals) {
        if (await proposalAlreadyExamined(jobId, String(proposal["id"]))) continue;
        await insertCandidate(auditRow(proposal, {
          status: "skipped", extraction_notes: "insurance job — out of scope for price automation", raw: "{}",
        }));
        result.details.push({ job_number: jobNumber, proposal_id: String(proposal["id"]), outcome: "insurance" });
      }
      continue;
    }

    // The LIVE financials decide whether a price is needed — never the mirror.
    let existingPrice = 0;
    try {
      const summary = await client.financialSummary(jobId);
      existingPrice = Number(summary?.["total_job_price"] ?? 0) || 0;
    } catch {
      // A refused summary (the API 412s on some jobs) must not hide a missing
      // price — proceed to extraction; the approve step re-checks anyway.
    }
    if (existingPrice > 0) {
      for (const proposal of proposals) {
        if (await proposalAlreadyExamined(jobId, String(proposal["id"]))) continue;
        await insertCandidate(auditRow(proposal, {
          status: "skipped",
          extraction_notes: `price already set in JobProgress ($${existingPrice}) — no action needed`,
          raw: "{}",
        }));
        result.details.push({ job_number: jobNumber, proposal_id: String(proposal["id"]), outcome: "already_priced" });
      }
      continue;
    }

    for (const proposal of proposals) {
      const proposalId = String(proposal["id"]);
      if (await proposalAlreadyExamined(jobId, proposalId)) {
        result.already_examined++;
        continue;
      }
      result.proposals_examined++;

      try {
        const file = await client.downloadFile(String(proposal["url"]));
        const extraction = await extract(file.data);
        const { status, notes } = candidateStatus(extraction, jobNumber);
        await insertCandidate(auditRow(proposal, {
          classification: extraction.classification,
          extracted_amount: extraction.amount,
          extracted_job_number: extraction.jobNumber,
          confidence: notes.length > (extraction.notes ? 1 : 0) ? "low" : extraction.confidence,
          extraction_notes: notes.join("; ") || null,
          model: extraction.model,
          status,
          raw: JSON.stringify({ proposal: { ...proposal, url: undefined, thumb: undefined } }),
        }));
        result.candidates_created++;
        result.details.push({ job_number: jobNumber, proposal_id: proposalId, outcome: status });
      } catch (err) {
        result.extraction_errors++;
        await insertCandidate(auditRow(proposal, {
          classification: "unreadable",
          extraction_notes: `extraction failed: ${(err as Error).message}`.slice(0, 400),
          status: "failed",
          raw: "{}",
        }));
        result.details.push({ job_number: jobNumber, proposal_id: proposalId, outcome: "failed" });
      }
    }
  }
  console.info(
    `[price-scan] ${result.jobs_scanned} job(s), ${result.proposals_examined} proposal(s) examined, `
    + `${result.candidates_created} candidate(s), ${result.extraction_errors} error(s)`);
  return result;
}

/** expose: the message is safe and useful for the admin UI even on 5xx (e.g. a
 *  502 carrying JobProgress's own rejection reason). */
function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number; expose: boolean };
  err.statusCode = statusCode;
  err.expose = true;
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
  // LIVE summary decides when it can — JobProgress refuses this endpoint with
  // HTTP 412 on some jobs, so a refusal falls back to our mirror rather than
  // making the job un-approvable forever. The fallback is recorded on the row.
  let existing = 0;
  let liveCheckNote = "";
  try {
    const summary = await jp.financialSummary(row.jp_job_id);
    existing = Number(unwrap<Record<string, unknown>>(summary)?.["total_job_price"] ?? summary?.["total_job_price"] ?? 0) || 0;
  } catch (err) {
    const mirror = await withServiceRole(async (c) => {
      const { rows } = await c.query<{ total_job_price: string | null }>(
        `SELECT total_job_price FROM jp_job WHERE jp_job_id = $1`, [row.jp_job_id]);
      return Number(rows[0]?.total_job_price ?? 0) || 0;
    }, "price-approve:mirror-fallback", { quiet: true });
    existing = mirror;
    liveCheckNote = `live financial check unavailable (${(err as Error).message.slice(0, 80)}); mirror consulted instead`;
  }
  if (existing > 0) {
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
          SET status = 'applied', reviewed_by = $2, reviewed_at = now(), applied_at = now(), apply_error = NULL,
              extraction_notes = CASE WHEN $3 <> '' THEN coalesce(extraction_notes || '; ', '') || $3 ELSE extraction_notes END
        WHERE id = $1`,
      [candidateId, actor, liveCheckNote]);
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
