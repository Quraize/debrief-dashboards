/**
 * JobProgress synchronisation.
 *
 * Replaces `base44/functions/syncLeapJobProgress`. Three things are materially
 * different from the version it replaces:
 *
 *  1. It is **idempotent by construction**. Records are upserted on
 *     `identity_key`, so re-running cannot duplicate anything — where the old
 *     version matched against a 500-row window and silently recreated anything
 *     older on every run.
 *
 *  2. It is **incremental**. The watermark is the previous successful run's
 *     end, filtered on `appointment_updated_date`, so a result recorded today
 *     against a three-week-old appointment is picked up. An occurrence-date
 *     window structurally cannot see that.
 *
 *  3. It **writes its own telemetry**. `sync_run` and `sync_conflict` exist in
 *     the schema and have never been written by anything, so the admin UI has
 *     always shown "Last Successful Commit: Never" and an empty exceptions
 *     panel. Both are populated here.
 *
 * Beyond the operational `appointment` table (sales-type rows only, feeding
 * debrief matching), a commit also maintains the CRM mirror:
 *
 *  * `jp_appointment` — every appointment examined, non-sales included, with
 *    the result form's parsed Two-Leg answer;
 *  * `jp_job` — jobs signed in the window, with their financial summaries.
 *
 * Runs on the allied_jobs pool: a sync legitimately writes rows on behalf of
 * every user, which is exactly what that connection is for.
 */
import { withServiceRole } from "../db/client.js";
import { JobProgressClient, unwrap, unwrapMany, hasResult } from "../integrations/jobprogress/client.js";
import { isNonSalesTitle } from "@allied/shared/nonSalesActivity";
import { parseTwoLegAnswer, findTwoLegField, resultGroupName } from "@allied/shared/jpResult";

export type SyncMode = "dry_run" | "commit";

export interface SyncOptions {
  mode: SyncMode;
  /** Occurrence-date window. Used for a backfill; ignored when incremental. */
  dateFrom?: string;
  dateTo?: string;
  /** Ignore the watermark and sweep the whole window. */
  fullBackfill?: boolean;
  startedBy?: string;
  client?: JobProgressClient;
}

export interface SyncCounts {
  api_appointments_examined: number;
  appointment_results_available: number;
  appointment_results_missing: number;
  proposed_new_appointments: number;
  proposed_updates: number;
  created: number;
  updated: number;
  unchanged: number;
  non_sales_exclusions: number;
  signed_sales_found: number;
  jp_appointments_upserted: number;
  jp_results_fetched: number;
  jp_two_leg_answers: number;
  jp_jobs_upserted: number;
  financial_summaries_fetched: number;
  financial_summary_errors: number;
  revenue_total: number;
  conflicts: number;
  api_requests: number;
  retries: number;
  rate_limit_hits: number;
  errors: number;
}

export interface SyncResult {
  syncRunId: string;
  mode: SyncMode;
  status: "completed" | "failed";
  counts: SyncCounts;
  conflicts: { category: string; reason: string }[];
  incrementalSince: string | null;
  errorMessage?: string;
}

interface Conflict {
  category: string;
  reason: string;
  leadId?: string;
  jobId?: string;
  appointmentId?: string;
}

const emptyCounts = (): SyncCounts => ({
  api_appointments_examined: 0,
  appointment_results_available: 0,
  appointment_results_missing: 0,
  proposed_new_appointments: 0,
  proposed_updates: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  non_sales_exclusions: 0,
  signed_sales_found: 0,
  jp_appointments_upserted: 0,
  jp_results_fetched: 0,
  jp_two_leg_answers: 0,
  jp_jobs_upserted: 0,
  financial_summaries_fetched: 0,
  financial_summary_errors: 0,
  revenue_total: 0,
  conflicts: 0,
  api_requests: 0,
  retries: 0,
  rate_limit_hits: 0,
  errors: 0,
});

/** `YYYY-MM-DD HH:MM:SS`, the format the API's date filters expect. */
function apiTimestamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * The watermark for an incremental run: when the last successful commit
 * finished, less a safety overlap.
 *
 * The overlap matters. Without it, anything modified between the last query and
 * that run's completion falls in the gap and is never seen again — and because
 * upserts are idempotent, re-examining a few records costs nothing.
 */
async function lastSuccessfulSync(overlapMinutes = 30): Promise<Date | null> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ finished_at: Date }>(
      `SELECT finished_at FROM sync_run
        WHERE mode = 'commit' AND status = 'completed' AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`);
    if (!rows[0]) return null;
    return new Date(rows[0].finished_at.getTime() - overlapMinutes * 60_000);
  }, "sync:last-watermark");
}

async function openSyncRun(
  mode: SyncMode, from: string, to: string, incrementalSince: Date | null,
  fullBackfill: boolean, startedBy: string | undefined,
): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (mode, status, date_from, date_to, incremental_since, full_backfill, started_by)
       VALUES ($1,'running',$2,$3,$4,$5,$6) RETURNING id`,
      [mode, from, to, incrementalSince, fullBackfill, startedBy ?? null]);
    return rows[0]!.id;
  }, "sync:open-run");
}

async function closeSyncRun(
  id: string, status: "completed" | "failed", counts: SyncCounts, errorMessage?: string,
): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE sync_run
          SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4
        WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "sync:close-run");
}

async function recordConflicts(syncRunId: string, conflicts: Conflict[]): Promise<void> {
  if (conflicts.length === 0) return;
  await withServiceRole(async (c) => {
    for (const conflict of conflicts) {
      await c.query(
        `INSERT INTO sync_conflict (sync_run_id, category, reason, crm_lead_id, crm_job_id, appointment_record_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [syncRunId, conflict.category, conflict.reason,
         conflict.leadId ?? null, conflict.jobId ?? null, conflict.appointmentId ?? null]);
    }
  }, "sync:record-conflicts");
}

/**
 * Maps an API appointment to our columns.
 *
 * Every included relation goes through `unwrap`, which is the fix for the defect
 * in docs/jobprogress-api.md §2.3: the old client read `customer`, `user` and
 * `created_by` without unwrapping `.data`, so contact and rep fields may have
 * been imported blank all along.
 */
export function mapAppointment(
  apiAppointment: Record<string, unknown>, divisionNames: Map<string, string>,
): Record<string, unknown> {
  const jobs = unwrapMany<Record<string, unknown>>(apiAppointment["jobs"]);
  const job = jobs[0] ?? null;
  const customer = unwrap<Record<string, unknown>>(apiAppointment["customer"]) ?? {};
  const user = unwrap<Record<string, unknown>>(apiAppointment["user"]) ?? {};
  const createdBy = unwrap<Record<string, unknown>>(apiAppointment["created_by"]) ?? {};

  const startsAt = String(apiAppointment["start_date_time"] ?? "").replace("T", " ");
  const title = String(apiAppointment["title"] ?? "");

  const name = (obj: Record<string, unknown>): string => {
    const full = obj["name"];
    if (typeof full === "string" && full.trim()) return full.trim();
    return [obj["first_name"], obj["last_name"]].filter(Boolean).join(" ").trim();
  };

  const divisionId = job?.["division_id"];
  const division = divisionId == null ? "" : divisionNames.get(String(divisionId)) ?? "";

  return {
    appointment_record_id: String(apiAppointment["id"] ?? ""),
    crm_lead_id: job?.["number"] != null ? String(job["number"]) : null,
    crm_job_id: job?.["id"] != null ? String(job["id"]) : null,
    customer_name: (job?.["name"] as string) || name(customer) || title || "Unknown",
    contact_name: (customer["contact_name"] as string) ?? null,
    phone: (customer["phone"] as string) ?? (customer["mobile"] as string) ?? null,
    email: (customer["email"] as string) ?? null,
    address: (apiAppointment["location"] as string) ?? (customer["address"] as string) ?? null,
    city: (customer["city"] as string) ?? null,
    appointment_date: startsAt.slice(0, 10) || null,
    appointment_time: startsAt.slice(11, 16) || null,
    original_sales_rep: name(user) || null,
    original_appointment_setter: name(createdBy) || null,
    product: division || null,
    business_division: job?.["insurance"] ? "Insurance" : null,
    title,
    is_sales_appointment: !isNonSalesTitle(title),
  };
}

/**
 * Normalizes a result payload — the listing's inline `result`, or the body of
 * `GET /appointments/{id}/result` — into a flat array of {name, value} fields.
 * The shape varies (bare array, `.data` wrapper, object with `fields`), so
 * this is deliberately tolerant: an unrecognized shape yields [], never a throw.
 */
export function extractResultFields(value: unknown): { name?: unknown; value?: unknown }[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter((f) => f && typeof f === "object");
  if (typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  if ("data" in obj) return extractResultFields(obj["data"]);
  if (Array.isArray(obj["fields"])) return extractResultFields(obj["fields"]);
  if (Array.isArray(obj["result"])) return extractResultFields(obj["result"]);
  return [];
}

/** Maps an API appointment to a `jp_appointment` mirror row. */
export function mapJpAppointment(
  apiAppointment: Record<string, unknown>, divisionNames: Map<string, string>,
): Record<string, unknown> {
  const jobs = unwrapMany<Record<string, unknown>>(apiAppointment["jobs"]);
  const job = jobs[0] ?? null;
  const customer = unwrap<Record<string, unknown>>(apiAppointment["customer"]) ?? {};
  const user = unwrap<Record<string, unknown>>(apiAppointment["user"]) ?? {};
  const createdBy = unwrap<Record<string, unknown>>(apiAppointment["created_by"]) ?? {};
  const resultOption = unwrap<Record<string, unknown>>(apiAppointment["result_option"]);

  const startsAt = String(apiAppointment["start_date_time"] ?? "").replace("T", " ");
  const title = String(apiAppointment["title"] ?? "");

  const name = (obj: Record<string, unknown>): string => {
    const full = obj["name"];
    if (typeof full === "string" && full.trim()) return full.trim();
    return [obj["first_name"], obj["last_name"]].filter(Boolean).join(" ").trim();
  };

  const divisionId = job?.["division_id"];
  const division = divisionId == null ? "" : divisionNames.get(String(divisionId)) ?? "";

  const twoLegRaw = findTwoLegField(extractResultFields(apiAppointment["result"]));

  // The heavy includes are extracted above (and jobs live in jp_job); keeping
  // them out of `raw` keeps rows small and avoids duplicating customer PII.
  const {
    jobs: _jobs, customer: _customer, user: _user, created_by: _createdBy,
    attendees: _attendees, invites: _invites, ...rawRest
  } = apiAppointment;

  return {
    jp_appointment_id: String(apiAppointment["id"] ?? ""),
    title: title || null,
    appointment_date: startsAt.slice(0, 10) || null,
    appointment_time: startsAt.slice(11, 16) || null,
    customer_name: (job?.["name"] as string) || name(customer) || null,
    location: (apiAppointment["location"] as string) ?? null,
    crm_lead_id: job?.["number"] != null ? String(job["number"]) : null,
    crm_job_id: job?.["id"] != null ? String(job["id"]) : null,
    sales_rep: name(user) || null,
    appointment_setter: name(createdBy) || null,
    division: division || null,
    is_sales_type: !isNonSalesTitle(title),
    is_insurance: Boolean(job?.["insurance"]),
    has_result: hasResult(apiAppointment),
    result_group: resultGroupName(resultOption),
    result_option_name: resultOption?.["name"] != null ? String(resultOption["name"]) : null,
    two_leg_answer: twoLegRaw != null ? parseTwoLegAnswer(twoLegRaw) : null,
    two_leg_raw: twoLegRaw,
    jp_created_at: (apiAppointment["created_at"] as string) ?? null,
    jp_updated_at: (apiAppointment["updated_at"] as string) ?? null,
    raw: JSON.stringify(rawRest),
  };
}

/** Maps an API job (from the signed-jobs query) to a `jp_job` mirror row. */
export function mapJpJob(
  apiJob: Record<string, unknown>, divisionNames: Map<string, string>,
): Record<string, unknown> {
  const division = unwrap<Record<string, unknown>>(apiJob["division"]);
  const trades = unwrapMany<Record<string, unknown>>(apiJob["trades"]);
  const stage = unwrap<Record<string, unknown>>(apiJob["current_stage"]);
  const divisionId = apiJob["division_id"];

  const { customer: _customer, ...rawRest } = apiJob;

  return {
    jp_job_id: String(apiJob["id"] ?? ""),
    job_number: apiJob["number"] != null ? String(apiJob["number"]) : null,
    job_name: (apiJob["name"] as string) ?? null,
    division: (division?.["name"] as string)
      ?? (divisionId != null ? divisionNames.get(String(divisionId)) ?? null : null),
    trades: trades.map((t) => t["name"]).filter(Boolean).join(", ") || null,
    is_insurance: Boolean(apiJob["insurance"]),
    current_stage: (stage?.["name"] as string) ?? null,
    contract_signed_date: apiJob["contract_signed_date"]
      ? String(apiJob["contract_signed_date"]).slice(0, 10)
      : null,
    jp_created_at: (apiJob["created_at"] as string) ?? (apiJob["created_date"] as string) ?? null,
    jp_updated_at: (apiJob["updated_at"] as string) ?? null,
    raw: JSON.stringify(rawRest),
  };
}

/**
 * Upserts operational appointments on identity_key — the constraint that makes
 * this safe to re-run. One transaction for the whole batch: a backfill month is
 * ~120 rows, and a per-row BEGIN/COMMIT round-trip was the old cost model.
 */
async function upsertAppointments(
  rows: Record<string, unknown>[],
): Promise<{ created: number; updated: number }> {
  if (rows.length === 0) return { created: 0, updated: 0 };
  return withServiceRole(async (c) => {
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      // Provenance is never overwritten by a later sync — the same rule the
      // Base44 importer needed.
      const updates = columns
        .filter((col) => !["created_at", "created_by"].includes(col))
        .map((col) => `"${col}" = EXCLUDED."${col}"`)
        .join(", ");
      const { rows: result } = await c.query<{ created: boolean }>(
        `INSERT INTO appointment (${columns.map((col) => `"${col}"`).join(", ")}, created_by)
         VALUES (${placeholders}, 'jobprogress-sync')
         ON CONFLICT (identity_key) DO UPDATE SET ${updates}, updated_at = now()
         RETURNING (xmax = 0) AS created`,
        columns.map((col) => row[col]));
      if (result[0]!.created) created++;
      else updated++;
    }
    return { created, updated };
  }, "sync:upsert-appointments");
}

/** Generic batched upsert for the jp mirror tables (natural-key conflict). */
async function upsertJpRows(
  table: "jp_appointment" | "jp_job", conflictColumn: string, rows: Record<string, unknown>[],
): Promise<number> {
  if (rows.length === 0) return 0;
  return withServiceRole(async (c) => {
    for (const row of rows) {
      const columns = Object.keys(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
      const updates = columns
        .filter((col) => col !== "created_at")
        .map((col) => `"${col}" = EXCLUDED."${col}"`)
        .join(", ");
      await c.query(
        `INSERT INTO ${table} (${columns.map((col) => `"${col}"`).join(", ")})
         VALUES (${placeholders})
         ON CONFLICT (${conflictColumn}) DO UPDATE SET ${updates}`,
        columns.map((col) => row[col]));
    }
    return rows.length;
  }, `sync:upsert-${table}`);
}

async function updateJpJobFinancials(
  jpJobId: string,
  fin: { revenue: number | null; price: number | null; changeOrders: number | null },
): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE jp_job
          SET total_job_revenue = $2, total_job_price = $3,
              total_change_order_amount = $4, financials_fetched_at = now()
        WHERE jp_job_id = $1`,
      [jpJobId, fin.revenue, fin.price, fin.changeOrders]);
  }, "sync:update-jp-financials", { quiet: true });
}

/** Reads a money field the API may return as number, string, or absent. */
function money(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function runJobProgressSync(options: SyncOptions): Promise<SyncResult> {
  const counts = emptyCounts();
  const conflicts: Conflict[] = [];

  const client = options.client ?? new JobProgressClient({
    onStat: (stat) => {
      if (stat === "request") counts.api_requests++;
      else if (stat === "retry") counts.retries++;
      else if (stat === "rateLimitHit") counts.rate_limit_hits++;
      else if (stat === "error") counts.errors++;
    },
  });

  const now = new Date();
  const watermark = options.fullBackfill ? null : await lastSuccessfulSync();
  const dateFrom = options.dateFrom ?? apiTimestamp(watermark ?? new Date(now.getTime() - 86_400_000)).slice(0, 10);
  const dateTo = options.dateTo ?? apiTimestamp(now).slice(0, 10);

  const syncRunId = await openSyncRun(
    options.mode, dateFrom, dateTo, watermark, options.fullBackfill ?? false, options.startedBy);

  try {
    const divisions = await client.listDivisions();
    const divisionNames = new Map<string, string>();
    for (const d of divisions) {
      if (d["id"] != null) divisionNames.set(String(d["id"]), String(d["name"] ?? ""));
    }

    // Incremental when we have a watermark, occurrence-date otherwise.
    const appointments = watermark
      ? await client.listAppointmentsUpdatedSince(apiTimestamp(watermark), apiTimestamp(now))
      : await client.listAppointmentsByDate(dateFrom, dateTo);

    counts.api_appointments_examined = appointments.length;

    const salesRows: Record<string, unknown>[] = [];
    const jpRows: Record<string, unknown>[] = [];

    for (const appointment of appointments) {
      if (hasResult(appointment)) counts.appointment_results_available++;
      else counts.appointment_results_missing++;

      // The mirror stores every appointment — non-sales included, flagged.
      // Filtering them out here would rebuild the blind spot the mirror exists
      // to expose (August: 13 of 119 were non-sales).
      const jpRow = mapJpAppointment(appointment, divisionNames);
      if (jpRow["jp_appointment_id"]) jpRows.push(jpRow);

      const row = mapAppointment(appointment, divisionNames);

      if (!row["is_sales_appointment"]) {
        counts.non_sales_exclusions++;
        continue;
      }
      if (!row["appointment_date"]) {
        conflicts.push({
          category: "missing_data",
          reason: "Appointment has no start_date_time; cannot establish identity",
          leadId: (row["crm_lead_id"] as string) ?? undefined,
          appointmentId: (row["appointment_record_id"] as string) ?? undefined,
        });
        continue;
      }

      if (options.mode === "dry_run") {
        counts.proposed_new_appointments++;
        continue;
      }
      salesRows.push(row);
    }

    if (options.mode === "commit") {
      // Fallback result fetches: the listing usually carries `result` inline;
      // only appointments whose result exists but arrived without fields cost
      // an extra call. The rate limiter paces these like everything else.
      for (const jpRow of jpRows) {
        if (jpRow["has_result"] !== true || jpRow["two_leg_raw"] != null) continue;
        const id = String(jpRow["jp_appointment_id"]);
        try {
          const fetched = await client.appointmentResult(id);
          counts.jp_results_fetched++;
          const rawText = findTwoLegField(extractResultFields(fetched));
          if (rawText != null) {
            jpRow["two_leg_raw"] = rawText;
            jpRow["two_leg_answer"] = parseTwoLegAnswer(rawText);
          }
        } catch (err) {
          if (conflicts.length < 20) {
            conflicts.push({
              category: "missing_result",
              reason: `Result fetch failed for appointment ${id}: ${(err as Error).message}`.slice(0, 400),
              appointmentId: id,
            });
          }
        }
      }
      counts.jp_two_leg_answers = jpRows.filter((r) => r["two_leg_answer"] != null).length;

      counts.jp_appointments_upserted = await upsertJpRows("jp_appointment", "jp_appointment_id", jpRows);
      const outcome = await upsertAppointments(salesRows);
      counts.created = outcome.created;
      counts.updated = outcome.updated;
    }

    // Signed sales in one query rather than per-job probing (docs §3.2).
    const signed = await client.listJobsSignedBetween(dateFrom, dateTo);
    counts.signed_sales_found = signed.length;

    if (options.mode === "commit" && signed.length > 0) {
      const jobRows = signed
        .map((j) => mapJpJob(j, divisionNames))
        .filter((r) => r["jp_job_id"]);
      counts.jp_jobs_upserted = await upsertJpRows("jp_job", "jp_job_id", jobRows);

      // The signed-jobs listing carries financial_details, but the numbers the
      // business reconciles against live in the financial *summary* — fetched
      // per job, signed jobs only, so the call count stays proportional to
      // sales rather than appointments.
      for (const row of jobRows) {
        const id = String(row["jp_job_id"]);
        counts.financial_summaries_fetched++;
        try {
          const record = await client.financialSummary(id);
          const revenue = money(record?.["total_job_revenue"])
            ?? ((money(record?.["total_job_price"]) ?? 0) + (money(record?.["total_change_order_amount"]) ?? 0) || null);
          await updateJpJobFinancials(id, {
            revenue,
            price: money(record?.["total_job_price"]),
            changeOrders: money(record?.["total_change_order_amount"]),
          });
          counts.revenue_total += revenue ?? 0;
        } catch (err) {
          counts.financial_summary_errors++;
          if (conflicts.length < 20) {
            conflicts.push({
              category: "api_error",
              reason: `Financial summary failed for job ${id}: ${(err as Error).message}`.slice(0, 400),
              jobId: id,
            });
          }
        }
      }
    }

    counts.proposed_updates = counts.updated;
    counts.conflicts = conflicts.length;

    await recordConflicts(syncRunId, conflicts);
    await closeSyncRun(syncRunId, "completed", counts);

    return {
      syncRunId, mode: options.mode, status: "completed", counts,
      conflicts: conflicts.map(({ category, reason }) => ({ category, reason })),
      incrementalSince: watermark ? watermark.toISOString() : null,
    };
  } catch (err) {
    counts.errors++;
    const message = (err as Error).message;
    // A failed run is still recorded: a sync that vanishes without trace is the
    // reason the old implementation's status bar was permanently blank.
    await recordConflicts(syncRunId, [...conflicts, {
      category: "api_error", reason: message.slice(0, 400),
    }]);
    await closeSyncRun(syncRunId, "failed", counts, message);
    return {
      syncRunId, mode: options.mode, status: "failed", counts,
      conflicts: conflicts.map(({ category, reason }) => ({ category, reason })),
      incrementalSince: watermark ? watermark.toISOString() : null,
      errorMessage: message,
    };
  }
}
