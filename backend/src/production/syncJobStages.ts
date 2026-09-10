/**
 * Jobs-by-stage sync: the workflow stage list and every job in a TRACKED
 * stage (Project Won / Production / Warranty Work) → jp_workflow_stage and
 * jp_job, plus job locations for the map.
 *
 * Runs with the production schedule (every ten minutes). Two sweeps:
 *   1. stages[] query for the tracked stage codes — new and current jobs;
 *   2. jobs the board still shows as tracked but the query did not return —
 *      they moved to an untracked stage (paid, lost…), so we re-read them by
 *      id and record the new stage. Without this a finished job would sit in
 *      "COMPLETED NEED FINAL PAYMENT" on our board forever.
 */
import { withServiceRole } from "../db/client.js";
import { JobProgressClient, unwrap } from "../integrations/jobprogress/client.js";
import {
  mapJpJob, upsertJpRows, financialsFromRecord, isCompleteFinancialRecord, updateJpJobFinancials,
} from "../jobs/syncJobProgress.js";
import { parseApiTimestamp } from "./syncSchedules.js";
import { isTrackedStage } from "@allied/shared/jobStages";
import { classifyVendor } from "@allied/shared/weeklyJobSheet";

export interface StageSyncCounts {
  stages_examined: number;
  stages_tracked: number;
  jobs_examined: number;
  jobs_upserted: number;
  jobs_moved_out: number;
  locations_fetched: number;
  /** Money columns filled straight from the listing's financial_details include. */
  financials_from_listing: number;
  /** Per-job financial_summary calls this run (stale rows only, capped). */
  financial_summaries_fetched: number;
  financial_summary_errors: number;
  /** Jobs whose payment history was (re)read this run, and the payments written. */
  payments_jobs_fetched: number;
  payments_upserted: number;
  payments_retired: number;
  payment_errors: number;
  /** Jobs whose vendor bills were (re)read this run, and the bills written. */
  bills_jobs_fetched: number;
  bills_upserted: number;
  bills_retired: number;
  bill_errors: number;
  api_requests: number;
  retries: number;
  rate_limit_hits: number;
  errors: number;
}

/**
 * Money is refreshed for at most this many tracked jobs per ten-minute run
 * when the listing did not carry it — one API call each, so the cap keeps the
 * sweep well inside the shared 55/min budget. A job's figures are re-read when
 * JobProgress reports the job changed since the last read, and at least twice
 * a day regardless (payments are recorded without touching the job record).
 */
export const FINANCIALS_PER_RUN_DEFAULT = 40;
export const FINANCIALS_MAX_AGE_HOURS = 12;

export interface StageSyncOptions { startedBy?: string; client?: JobProgressClient }
export interface StageSyncResult {
  syncRunId: string; status: "completed" | "failed"; counts: StageSyncCounts; errorMessage?: string;
}

const emptyCounts = (): StageSyncCounts => ({
  stages_examined: 0, stages_tracked: 0, jobs_examined: 0, jobs_upserted: 0, jobs_moved_out: 0,
  locations_fetched: 0, financials_from_listing: 0, financial_summaries_fetched: 0, financial_summary_errors: 0,
  payments_jobs_fetched: 0, payments_upserted: 0, payments_retired: 0, payment_errors: 0,
  bills_jobs_fetched: 0, bills_upserted: 0, bills_retired: 0, bill_errors: 0,
  api_requests: 0, retries: 0, rate_limit_hits: 0, errors: 0,
});

/** Vendor bills have no change signal on the job, so each job's list is re-read this often. */
export const BILLS_MAX_AGE_HOURS = 24;

const str = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function openRun(startedBy: string | undefined): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('job_stages','commit','running', current_date, current_date, false, $1) RETURNING id`,
      [startedBy ?? null]);
    return rows[0]!.id;
  }, "job-stages:open-run", { quiet: true });
}
async function closeRun(id: string, status: "completed" | "failed", counts: StageSyncCounts, errorMessage?: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(`UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4 WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "job-stages:close-run", { quiet: true });
}

/** Upserts the stage list; returns the codes of the tracked stages. */
async function upsertStages(stages: Record<string, unknown>[], counts: StageSyncCounts): Promise<string[]> {
  counts.stages_examined = stages.length;
  const tracked: string[] = [];
  await withServiceRole(async (c) => {
    for (const s of stages) {
      const code = str(s["code"]);
      const name = str(s["name"]);
      if (!code || !name) continue;
      await c.query(
        `INSERT INTO jp_workflow_stage (jp_stage_id, code, name, position, color, locked, jobs_count, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (code) DO UPDATE SET jp_stage_id = EXCLUDED.jp_stage_id, name = EXCLUDED.name,
           position = EXCLUDED.position, color = EXCLUDED.color, locked = EXCLUDED.locked,
           jobs_count = EXCLUDED.jobs_count, last_seen_at = now()`,
        [str(s["id"]), code, name, num(s["position"]), str(s["color"]),
         s["locked"] === 1 || s["locked"] === true, num(s["jobs_count"])]);
      if (isTrackedStage(name)) tracked.push(code);
    }
  }, "job-stages:stages", { quiet: true });
  counts.stages_tracked = tracked.length;
  return tracked;
}

async function upsertLocations(jobs: Record<string, unknown>[], counts: StageSyncCounts): Promise<void> {
  await withServiceRole(async (c) => {
    for (const job of jobs) {
      const id = str(job["id"]);
      const addr = unwrap(job["address"]);
      if (!id || !addr) continue;
      const state = str(unwrap(addr["state"])?.["code"]) ?? str(addr["state"]);
      await c.query(
        `INSERT INTO jp_job_location (jp_job_id, address, address_line_1, city, state, zip, lat, lng, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (jp_job_id) DO UPDATE SET address = EXCLUDED.address, address_line_1 = EXCLUDED.address_line_1,
           city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip, lat = EXCLUDED.lat, lng = EXCLUDED.lng, fetched_at = now()`,
        [id, str(addr["address"]), str(addr["address_line_1"]), str(addr["city"]), state, str(addr["zip"]),
         num(addr["lat"]), num(addr["long"]) ?? num(addr["lng"])]);
      counts.locations_fetched++;
    }
  }, "job-stages:locations", { quiet: true });
}

/**
 * Fills the Weekly Job Sheet's money columns for the tracked jobs. Two paths:
 * a listing whose `financial_details` include is complete costs nothing; the
 * rest are read from /jobs/{id}/financial_summary, stalest first, up to the
 * per-run cap. A failed read is counted and skipped — the row keeps its last
 * figures and its old `financials_fetched_at`, so it is retried next run.
 */
export async function refreshFinancials(
  client: JobProgressClient, jobs: Record<string, unknown>[], counts: StageSyncCounts,
  perRun = Number(process.env.PRODUCTION_FINANCIALS_PER_RUN ?? FINANCIALS_PER_RUN_DEFAULT),
): Promise<void> {
  const fromListing = new Set<string>();
  for (const job of jobs) {
    const id = str(job["id"]);
    const record = unwrap(job["financial_details"]);
    if (!id || !isCompleteFinancialRecord(record)) continue;
    await updateJpJobFinancials(id, financialsFromRecord(record));
    fromListing.add(id);
    counts.financials_from_listing++;
  }

  if (perRun <= 0) return;
  const stale = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ jp_job_id: string }>(
      `SELECT jp_job_id FROM jp_job
        WHERE stage_seen_at IS NOT NULL
          AND NOT (jp_job_id = ANY($1::text[]))
          AND (financials_fetched_at IS NULL
               OR financials_fetched_at < jp_updated_at
               OR financials_fetched_at < now() - make_interval(hours => $2))
        ORDER BY financials_fetched_at NULLS FIRST, jp_job_id
        LIMIT $3`,
      [[...fromListing], FINANCIALS_MAX_AGE_HOURS, perRun]);
    return rows.map((r) => r.jp_job_id);
  }, "job-stages:financials-stale", { quiet: true });

  for (const id of stale) {
    try {
      counts.financial_summaries_fetched++;
      await updateJpJobFinancials(id, financialsFromRecord(await client.financialSummary(id)));
    } catch (err) {
      counts.financial_summary_errors++;
      console.warn(`[job-stages] financial summary failed for job ${id}: ${(err as Error).message}`);
    }
  }
}

const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/** One payment_history entry → a jp_job_payment row; null when it has no id or amount. */
export function mapPayment(
  api: Record<string, unknown>, jpJobId: string, labels: Map<string, string>,
): Record<string, unknown> | null {
  const id = str(api["id"]);
  const amount = num(api["payment"]) ?? num(api["amount"]);
  if (!id || amount === null) return null;
  const method = str(api["method"]) ?? str(api["payment_method"]);
  const status = str(api["status"]);
  const canceledRaw = api["canceled"] ?? api["cancelled"];
  const canceled = (canceledRaw != null && canceledRaw !== false && canceledRaw !== 0 && canceledRaw !== "0" && canceledRaw !== "")
    || /cancel|void/i.test(status ?? "");
  const date = str(api["date"]) ?? str(api["payment_date"]) ?? str(api["created_at"]);
  return {
    jp_payment_id: id,
    jp_job_id: str(api["job_id"]) ?? jpJobId,
    jp_customer_id: str(api["customer_id"]),
    amount,
    method,
    method_label: method ? labels.get(method.toLowerCase()) ?? null : null,
    payment_date: date ? date.slice(0, 10) : null,
    status,
    canceled,
    reference_number: str(api["reference_number"]) ?? str(api["echeque_number"]),
    raw: JSON.stringify(api),
    last_seen_at: new Date(),
    deleted_at: null,
  };
}

/**
 * Mirrors the payment list for tracked jobs whose payment TOTAL changed since
 * the list was last read (or was never read, or is a week old): one call per
 * job, capped per run like the money refresh. Payments that JobProgress no
 * longer returns for the job are retired, never erased.
 */
export async function refreshPayments(
  client: JobProgressClient, counts: StageSyncCounts,
  perRun = Number(process.env.PRODUCTION_FINANCIALS_PER_RUN ?? FINANCIALS_PER_RUN_DEFAULT),
): Promise<void> {
  if (perRun <= 0) return;
  const stale = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ jp_job_id: string; total: string | null }>(
      `SELECT jp_job_id, total_payment_received::text AS total FROM jp_job
        WHERE stage_seen_at IS NOT NULL
          AND (coalesce(total_payment_received, 0) > 0 OR coalesce(payments_fetched_total, 0) > 0)
          AND (payments_fetched_at IS NULL
               OR payments_fetched_total IS DISTINCT FROM total_payment_received
               OR payments_fetched_at < now() - interval '7 days')
        ORDER BY payments_fetched_at NULLS FIRST, jp_job_id
        LIMIT $1`,
      [perRun]);
    return rows;
  }, "job-stages:payments-stale", { quiet: true });
  if (stale.length === 0) return;

  const labels = new Map<string, string>();
  try {
    for (const t of await client.listPaymentTypes()) {
      const method = str(t["method"]);
      const label = str(t["label"]);
      if (method && label && !labels.has(method.toLowerCase())) labels.set(method.toLowerCase(), label);
    }
  } catch (err) {
    console.warn(`[job-stages] payment types unavailable, keeping method codes: ${(err as Error).message}`);
  }

  for (const { jp_job_id: id, total } of stale) {
    try {
      counts.payments_jobs_fetched++;
      const rows = (await client.listJobPayments(id))
        .map((p) => mapPayment(p, id, labels))
        .filter((r): r is Record<string, unknown> => r !== null);
      counts.payments_upserted += await upsertJpRows("jp_job_payment", "jp_payment_id", rows);
      await withServiceRole(async (c) => {
        const gone = await c.query(
          `UPDATE jp_job_payment SET deleted_at = now()
            WHERE jp_job_id = $1 AND deleted_at IS NULL AND NOT (jp_payment_id = ANY($2::text[]))`,
          [id, rows.map((r) => String(r["jp_payment_id"]))]);
        counts.payments_retired += gone.rowCount ?? 0;
        await c.query(
          `UPDATE jp_job SET payments_fetched_at = now(), payments_fetched_total = $2 WHERE jp_job_id = $1`,
          [id, total]);
      }, "job-stages:payments-mark", { quiet: true });
    } catch (err) {
      counts.payment_errors++;
      console.warn(`[job-stages] payment history failed for job ${id}: ${(err as Error).message}`);
    }
  }
}

/** One vendor_bills entry → a jp_vendor_bill row; null when it has no id. */
export function mapVendorBill(api: Record<string, unknown>, jpJobId: string): Record<string, unknown> | null {
  const id = str(api["id"]);
  if (!id) return null;
  const vendor = unwrap(api["vendor"]);
  const fullName = vendor ? [vendor["first_name"], vendor["last_name"]].map((x) => str(x) ?? "").join(" ").trim() : "";
  const vendorName = vendor ? (str(vendor["display_name"]) ?? (fullName || null)) : null;
  return {
    jp_bill_id: id,
    jp_job_id: str(api["job_id"]) ?? jpJobId,
    vendor_id: vendor ? str(vendor["id"]) : null,
    vendor_name: vendorName,
    vendor_origin: vendor ? str(vendor["origin"]) : null,
    category: classifyVendor(vendorName),
    bill_number: str(api["bill_number"]),
    bill_date: str(api["bill_date"])?.slice(0, 10) ?? null,
    due_date: str(api["due_date"])?.slice(0, 10) ?? null,
    note: str(api["note"]),
    total_amount: num(api["total_amount"]) ?? num(api["amount"]) ?? 0,
    tax_amount: num(api["tax_amount"]),
    origin: str(api["origin"]),
    raw: JSON.stringify({ ...api, file_path: undefined, attachments: undefined }),
    last_seen_at: new Date(),
    deleted_at: null,
  };
}

/**
 * Mirrors the vendor bills of tracked jobs never read or read more than a day
 * ago, one call per job, capped per run like the money refresh. Bills the API
 * no longer returns for the job are retired, never erased.
 */
export async function refreshVendorBills(
  client: JobProgressClient, counts: StageSyncCounts,
  perRun = Number(process.env.PRODUCTION_FINANCIALS_PER_RUN ?? FINANCIALS_PER_RUN_DEFAULT),
): Promise<void> {
  if (perRun <= 0) return;
  const stale = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ jp_job_id: string }>(
      `SELECT jp_job_id FROM jp_job
        WHERE stage_seen_at IS NOT NULL
          AND (bills_fetched_at IS NULL OR bills_fetched_at < now() - make_interval(hours => $1))
        ORDER BY bills_fetched_at NULLS FIRST, jp_job_id
        LIMIT $2`,
      [BILLS_MAX_AGE_HOURS, perRun]);
    return rows.map((r) => r.jp_job_id);
  }, "job-stages:bills-stale", { quiet: true });

  for (const id of stale) {
    try {
      counts.bills_jobs_fetched++;
      const rows = (await client.listJobVendorBills(id))
        .map((b) => mapVendorBill(b, id))
        .filter((r): r is Record<string, unknown> => r !== null);
      counts.bills_upserted += await upsertJpRows("jp_vendor_bill", "jp_bill_id", rows);
      await withServiceRole(async (c) => {
        const gone = await c.query(
          `UPDATE jp_vendor_bill SET deleted_at = now()
            WHERE jp_job_id = $1 AND deleted_at IS NULL AND NOT (jp_bill_id = ANY($2::text[]))`,
          [id, rows.map((r) => String(r["jp_bill_id"]))]);
        counts.bills_retired += gone.rowCount ?? 0;
        await c.query(`UPDATE jp_job SET bills_fetched_at = now() WHERE jp_job_id = $1`, [id]);
      }, "job-stages:bills-mark", { quiet: true });
    } catch (err) {
      counts.bill_errors++;
      console.warn(`[job-stages] vendor bills failed for job ${id}: ${(err as Error).message}`);
    }
  }
}

/** A jp_job row from a job payload, with the stage sweep's own extras. */
export function mapStageJob(api: Record<string, unknown>, divisionNames: Map<string, string>, seen: boolean): Record<string, unknown> {
  const row = mapJpJob(api, divisionNames);
  const stageTs = parseApiTimestamp(api["stage_last_modified"]);
  return {
    ...row,
    jp_customer_id: api["customer_id"] != null ? String(api["customer_id"]) : null,
    stage_last_modified: stageTs,
    stage_seen_at: seen ? new Date() : null,
  };
}

export async function runJobStageSync(options: StageSyncOptions = {}): Promise<StageSyncResult> {
  const counts = emptyCounts();
  const syncRunId = await openRun(options.startedBy);
  try {
    // Inside the try: a missing token is a failed run with a message, not a crash.
    const client = options.client ?? new JobProgressClient({
      onStat: (kind) => {
        if (kind === "request") counts.api_requests++;
        else if (kind === "retry") counts.retries++;
        else if (kind === "rateLimitHit") counts.rate_limit_hits++;
        else if (kind === "error") counts.errors++;
      },
    });
    const trackedCodes = await upsertStages(await client.listWorkflowStages(), counts);

    const divisionNames = new Map<string, string>();
    for (const d of await client.listDivisions()) {
      if (d["id"] != null && d["name"] != null) divisionNames.set(String(d["id"]), String(d["name"]));
    }

    // Sweep 1: everything currently in a tracked stage.
    const jobs = await client.listJobsInStages(trackedCodes);
    counts.jobs_examined = jobs.length;
    const rows = jobs.map((j) => mapStageJob(j, divisionNames, true)).filter((r) => r["jp_job_id"]);
    counts.jobs_upserted = await upsertJpRows("jp_job", "jp_job_id", rows);
    await upsertLocations(jobs, counts);
    await refreshFinancials(client, jobs, counts);
    await refreshPayments(client, counts);
    await refreshVendorBills(client, counts);

    // Sweep 2: jobs we last saw in a tracked stage that were not returned now.
    const seenIds = new Set(rows.map((r) => String(r["jp_job_id"])));
    const stale = await withServiceRole(async (c) => {
      const { rows: out } = await c.query<{ jp_job_id: string }>(
        `SELECT jp_job_id FROM jp_job WHERE stage_seen_at IS NOT NULL AND stage_code = ANY($1::text[])`,
        [trackedCodes]);
      return out.map((r) => r.jp_job_id).filter((id) => !seenIds.has(id));
    }, "job-stages:stale", { quiet: true });
    if (stale.length > 0) {
      const moved = await client.listJobsByIds(stale);
      const movedRows = moved.map((j) => mapStageJob(j, divisionNames, false)).filter((r) => r["jp_job_id"]);
      counts.jobs_moved_out = await upsertJpRows("jp_job", "jp_job_id", movedRows);
      // Jobs the API no longer returns at all (deleted): clear the tracked mark.
      const refreshed = new Set(movedRows.map((r) => String(r["jp_job_id"])));
      const gone = stale.filter((id) => !refreshed.has(id));
      if (gone.length > 0) {
        await withServiceRole(async (c) => {
          await c.query(`UPDATE jp_job SET stage_seen_at = NULL WHERE jp_job_id = ANY($1::text[])`, [gone]);
        }, "job-stages:gone", { quiet: true });
      }
    }

    await closeRun(syncRunId, "completed", counts);
    return { syncRunId, status: "completed", counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    counts.errors++;
    await closeRun(syncRunId, "failed", counts, message);
    return { syncRunId, status: "failed", counts, errorMessage: message };
  }
}
