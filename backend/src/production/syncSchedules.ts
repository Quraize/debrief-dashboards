/**
 * Production schedule sync: JobProgress production calendar → jp_schedule,
 * plus the job-address cache the board's map pins read from.
 *
 * Deliberately separate from the appointment sync (jobs/syncJobProgress.ts):
 * different endpoint, different cadence (production moves intra-day, so this
 * runs every 30 minutes over a short rolling window), and a different
 * audience. It shares only the telemetry table, tagged `kind='schedules'`.
 *
 * Idempotent by construction: schedules upsert on their JobProgress id, and a
 * schedule that stops appearing inside the fetched window is retired
 * (deleted_at) rather than erased — it comes back untouched if it reappears.
 */
import { withServiceRole } from "../db/client.js";
import { JobProgressClient, unwrap, unwrapMany } from "../integrations/jobprogress/client.js";
import { parseScheduleTitle } from "@allied/shared/production";

export interface ScheduleSyncCounts {
  schedules_examined: number;
  schedules_created: number;
  schedules_updated: number;
  schedules_retired: number;
  schedules_skipped: number;
  locations_fetched: number;
  locations_without_coordinates: number;
  api_requests: number;
  retries: number;
  rate_limit_hits: number;
  errors: number;
}

export interface ScheduleSyncOptions {
  /** Window bounds (YYYY-MM-DD, inclusive). Default: the rolling window. */
  from?: string;
  to?: string;
  startedBy?: string;
  /** Injected in tests; built from the environment otherwise. */
  client?: JobProgressClient;
  now?: Date;
}

export interface ScheduleSyncResult {
  syncRunId: string;
  status: "completed" | "failed";
  from: string;
  to: string;
  counts: ScheduleSyncCounts;
  errorMessage?: string;
}

/** A row ready for jp_schedule. */
export interface ScheduleRow {
  jp_schedule_id: string;
  jp_job_id: string | null;
  jp_customer_id: string | null;
  title: string | null;
  description: string | null;
  start_at: Date;
  end_at: Date;
  full_day: boolean;
  is_completed: boolean;
  is_recurring: boolean;
  series_id: string | null;
  job_type_code: string | null;
  job_number: string | null;
  job_name: string | null;
  job_stage: string | null;
  job_insurance: boolean | null;
  customer_name: string | null;
  crew_ids: string[];
  crew_names: string[];
  trades: string[];
  work_types: string[];
  jp_created_at: Date | null;
  jp_updated_at: Date | null;
  raw: Record<string, unknown>;
}

const emptyCounts = (): ScheduleSyncCounts => ({
  schedules_examined: 0,
  schedules_created: 0,
  schedules_updated: 0,
  schedules_retired: 0,
  schedules_skipped: 0,
  locations_fetched: 0,
  locations_without_coordinates: 0,
  api_requests: 0,
  retries: 0,
  rate_limit_hits: 0,
  errors: 0,
});

const DAY_MS = 86_400_000;
const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The rolling window. Looking back three weeks is what catches a multi-week
 * install that STARTED before today but is still on the board — the API
 * filters on start time, so a shorter look-back would drop it mid-job.
 */
export function scheduleWindow(now = new Date()): { from: string; to: string } {
  const back = Number(process.env.PRODUCTION_SCHEDULE_DAYS_BACK ?? 21);
  const ahead = Number(process.env.PRODUCTION_SCHEDULE_DAYS_AHEAD ?? 21);
  return {
    from: isoDay(new Date(now.getTime() - back * DAY_MS)),
    to: isoDay(new Date(now.getTime() + ahead * DAY_MS)),
  };
}

/** `YYYY-MM-DD HH:MM:SS` (UTC, as the API emits) → Date; anything else → null. */
export function parseApiTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !value) return null;
  const m = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === "" ? null : String(v);
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

function personName(p: Record<string, unknown>): string {
  const full = [p["first_name"], p["last_name"]].map((x) => str(x) ?? "").join(" ").trim();
  return full || str(p["name"]) || str(p["email"]) || `#${str(p["id"]) ?? "?"}`;
}

/** Maps one API schedule to our row. Returns null when it cannot be placed on a calendar. */
export function mapSchedule(api: Record<string, unknown>): ScheduleRow | null {
  const id = str(api["id"]);
  const start = parseApiTimestamp(api["start_date_time"]);
  const end = parseApiTimestamp(api["end_date_time"]) ?? start;
  if (!id || !start || !end) return null;

  const job = unwrap(api["job"]);
  const customer = unwrap(api["customer"]);
  const crews = unwrapMany(api["sub_contractors"]);
  const trades = unwrapMany(api["trades"]);
  const workTypes = unwrapMany(api["work_types"]);
  const title = str(api["title"]);
  const parsed = parseScheduleTitle(title);

  const customerName = customer
    ? ([customer["first_name"], customer["last_name"]].map((x) => str(x) ?? "").join(" ").trim()
        || str(customer["company_name"]))
    : null;

  return {
    jp_schedule_id: id,
    jp_job_id: str(api["job_id"]) ?? (job ? str(job["id"]) : null),
    jp_customer_id: str(api["customer_id"]) ?? (customer ? str(customer["id"]) : null),
    title,
    description: str(api["description"]),
    start_at: start,
    end_at: end < start ? start : end,
    full_day: bool(api["full_day"]),
    is_completed: bool(api["is_completed"]),
    is_recurring: bool(api["is_recurring"]),
    series_id: str(api["series_id"]),
    job_type_code: parsed.code,
    job_number: job ? str(job["number"]) : null,
    job_name: job ? str(job["name"]) : null,
    job_stage: job ? (str(job["current_stage"]) ?? str(unwrap(job["current_stage"])?.["name"])) : null,
    job_insurance: job ? bool(job["insurance"]) : null,
    customer_name: customerName ?? parsed.customer ?? null,
    crew_ids: crews.map((c) => str(c["id"])).filter((x): x is string => !!x),
    crew_names: crews.map(personName),
    trades: trades.map((t) => str(t["name"])).filter((x): x is string => !!x),
    work_types: workTypes.map((t) => str(t["name"])).filter((x): x is string => !!x),
    jp_created_at: parseApiTimestamp(api["created_at"]),
    jp_updated_at: parseApiTimestamp(api["updated_at"]),
    raw: api,
  };
}

async function openRun(from: string, to: string, startedBy: string | undefined): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('schedules','commit','running',$1,$2,false,$3) RETURNING id`,
      [from, to, startedBy ?? null]);
    return rows[0]!.id;
  }, "schedules:open-run", { quiet: true });
}

async function closeRun(
  id: string, status: "completed" | "failed", counts: ScheduleSyncCounts, errorMessage?: string,
): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4
        WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "schedules:close-run", { quiet: true });
}

const UPSERT_SCHEDULE = `
  INSERT INTO jp_schedule (
    jp_schedule_id, jp_job_id, jp_customer_id, title, description, start_at, end_at,
    full_day, is_completed, is_recurring, series_id, job_type_code, job_number, job_name,
    job_stage, job_insurance, customer_name, crew_ids, crew_names, trades, work_types,
    jp_created_at, jp_updated_at, raw, last_seen_at, deleted_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,now(),NULL)
  ON CONFLICT (jp_schedule_id) DO UPDATE SET
    jp_job_id = EXCLUDED.jp_job_id, jp_customer_id = EXCLUDED.jp_customer_id,
    title = EXCLUDED.title, description = EXCLUDED.description,
    start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, full_day = EXCLUDED.full_day,
    is_completed = EXCLUDED.is_completed, is_recurring = EXCLUDED.is_recurring,
    series_id = EXCLUDED.series_id, job_type_code = EXCLUDED.job_type_code,
    job_number = EXCLUDED.job_number, job_name = EXCLUDED.job_name, job_stage = EXCLUDED.job_stage,
    job_insurance = EXCLUDED.job_insurance, customer_name = EXCLUDED.customer_name,
    crew_ids = EXCLUDED.crew_ids, crew_names = EXCLUDED.crew_names,
    trades = EXCLUDED.trades, work_types = EXCLUDED.work_types,
    jp_created_at = EXCLUDED.jp_created_at, jp_updated_at = EXCLUDED.jp_updated_at,
    raw = EXCLUDED.raw, last_seen_at = now(), deleted_at = NULL
  RETURNING (xmax = 0) AS inserted`;

async function upsertSchedules(rows: ScheduleRow[], counts: ScheduleSyncCounts): Promise<void> {
  if (rows.length === 0) return;
  await withServiceRole(async (c) => {
    for (const r of rows) {
      const { rows: out } = await c.query<{ inserted: boolean }>(UPSERT_SCHEDULE, [
        r.jp_schedule_id, r.jp_job_id, r.jp_customer_id, r.title, r.description, r.start_at, r.end_at,
        r.full_day, r.is_completed, r.is_recurring, r.series_id, r.job_type_code, r.job_number, r.job_name,
        r.job_stage, r.job_insurance, r.customer_name, r.crew_ids, r.crew_names, r.trades, r.work_types,
        r.jp_created_at, r.jp_updated_at, JSON.stringify(r.raw),
      ]);
      if (out[0]?.inserted) counts.schedules_created++;
      else counts.schedules_updated++;
    }
  }, "schedules:upsert");
}

/**
 * Retires schedules JobProgress no longer returns for the window. The range
 * is shrunk by a day at each end so a boundary disagreement with the API's
 * own filter can never retire a live schedule.
 */
async function retireMissing(from: string, to: string, seenIds: string[]): Promise<number> {
  return withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE jp_schedule SET deleted_at = now()
        WHERE deleted_at IS NULL
          AND start_at >= (($1::date + 1) || ' 00:00:00')::timestamp AT TIME ZONE 'UTC'
          AND start_at <  (($2::date)     || ' 00:00:00')::timestamp AT TIME ZONE 'UTC'
          AND NOT (jp_schedule_id = ANY($3::text[]))`,
      [from, to, seenIds]);
    return rowCount ?? 0;
  }, "schedules:retire", { quiet: true });
}

/**
 * Which job addresses to (re)fetch: never seen, older than a month, or seen
 * without coordinates more than a day ago (the office may have fixed the
 * address in JobProgress since).
 */
async function locationsNeedingFetch(jobIds: string[]): Promise<string[]> {
  if (jobIds.length === 0) return [];
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT j.id FROM unnest($1::text[]) AS j(id)
         LEFT JOIN jp_job_location l ON l.jp_job_id = j.id
        WHERE l.jp_job_id IS NULL
           OR l.fetched_at < now() - interval '30 days'
           OR (l.lat IS NULL AND l.fetched_at < now() - interval '1 day')`,
      [jobIds]);
    return rows.map((r) => r.id);
  }, "schedules:locations-stale", { quiet: true });
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function refreshLocations(
  client: JobProgressClient, jobIds: string[], counts: ScheduleSyncCounts,
): Promise<void> {
  const stale = await locationsNeedingFetch(jobIds);
  if (stale.length === 0) return;
  const jobs = await client.listJobAddresses(stale);
  const byId = new Map(jobs.map((j) => [String(j["id"]), j]));

  await withServiceRole(async (c) => {
    for (const id of stale) {
      const job = byId.get(id);
      const addr = job ? unwrap(job["address"]) : null;
      const lat = addr ? num(addr["lat"]) : null;
      const lng = addr ? (num(addr["long"]) ?? num(addr["lng"])) : null;
      const state = addr ? (str(unwrap(addr["state"])?.["code"]) ?? str(addr["state"])) : null;
      await c.query(
        `INSERT INTO jp_job_location (jp_job_id, address, address_line_1, city, state, zip, lat, lng, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
         ON CONFLICT (jp_job_id) DO UPDATE SET
           address = EXCLUDED.address, address_line_1 = EXCLUDED.address_line_1,
           city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
           lat = EXCLUDED.lat, lng = EXCLUDED.lng, fetched_at = now()`,
        [id, addr ? str(addr["address"]) : null, addr ? str(addr["address_line_1"]) : null,
         addr ? str(addr["city"]) : null, state, addr ? str(addr["zip"]) : null, lat, lng]);
      counts.locations_fetched++;
      if (lat === null || lng === null) counts.locations_without_coordinates++;
    }
  }, "schedules:locations-upsert");
}

export async function runScheduleSync(options: ScheduleSyncOptions = {}): Promise<ScheduleSyncResult> {
  const counts = emptyCounts();
  const window = scheduleWindow(options.now);
  const from = options.from ?? window.from;
  const to = options.to ?? window.to;

  const client = options.client ?? new JobProgressClient({
    onStat: (kind) => {
      if (kind === "request") counts.api_requests++;
      else if (kind === "retry") counts.retries++;
      else if (kind === "rateLimitHit") counts.rate_limit_hits++;
      else if (kind === "error") counts.errors++;
    },
  });

  const syncRunId = await openRun(from, to, options.startedBy);
  try {
    const api = await client.listSchedules(from, to);
    counts.schedules_examined = api.length;

    const rows: ScheduleRow[] = [];
    for (const item of api) {
      const row = mapSchedule(item);
      if (row) rows.push(row);
      else counts.schedules_skipped++;
    }

    await upsertSchedules(rows, counts);
    counts.schedules_retired = await retireMissing(from, to, rows.map((r) => r.jp_schedule_id));

    const jobIds = [...new Set(rows.map((r) => r.jp_job_id).filter((x): x is string => !!x))];
    await refreshLocations(client, jobIds, counts);

    await closeRun(syncRunId, "completed", counts);
    return { syncRunId, status: "completed", from, to, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    counts.errors++;
    await closeRun(syncRunId, "failed", counts, message);
    return { syncRunId, status: "failed", from, to, counts, errorMessage: message };
  }
}

let inFlight: Promise<ScheduleSyncResult> | null = null;

/**
 * Manual "refresh now" for the board. Concurrent requests share one run —
 * five people pressing the button during a storm is one API sweep, not five.
 */
export function refreshSchedules(startedBy: string): Promise<ScheduleSyncResult> {
  if (!inFlight) {
    inFlight = runScheduleSync({ startedBy }).finally(() => { inFlight = null; });
  }
  return inFlight;
}
