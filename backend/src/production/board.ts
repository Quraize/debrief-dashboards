/**
 * The dispatch board query: everything scheduled on a day (or a short range),
 * with crew, status, parsed job type and the map coordinates.
 *
 * Read on the request path under the caller's own identity (RLS:
 * allied_is_production), never the service role — the one exception is the
 * sync-freshness line, which comes from the admin-only sync_run table and
 * carries no customer data.
 */
import { dbApp, withUser, withServiceRole, type SessionContext } from "../db/client.js";
import { parseScheduleTitle, scheduleStatus } from "@allied/shared/production";

/** The office's clock. Schedules are stored in UTC and shown in this zone. */
export const BOARD_TIMEZONE = "America/New_York";
/** Longest range one request may ask for. */
export const MAX_RANGE_DAYS = 31;

export interface BoardItem {
  id: string;
  jpScheduleId: string;
  jobId: string | null;
  customerId: string | null;
  title: string | null;
  description: string | null;
  /** Parsed from the title convention: code/label/town/address/customer. */
  parsed: ReturnType<typeof parseScheduleTitle>;
  startAt: string;
  endAt: string;
  startDay: string;
  endDay: string;
  startTime: string;
  endTime: string;
  fullDay: boolean;
  multiDay: boolean;
  isCompleted: boolean;
  status: "assigned" | "unassigned" | "completed";
  jobNumber: string | null;
  jobName: string | null;
  jobStage: string | null;
  insurance: boolean | null;
  customerName: string | null;
  crews: { id: string; name: string }[];
  trades: string[];
  workTypes: string[];
  location: {
    address: string | null; addressLine1: string | null; city: string | null;
    state: string | null; zip: string | null; lat: number | null; lng: number | null;
  } | null;
  jpUrl: string | null;
  jpUpdatedAt: string | null;
  /** The job's current workflow stage (from the jobs mirror), when known. */
  stage: string | null;
  stageCode: string | null;
}

export interface Board {
  from: string;
  to: string;
  timezone: string;
  items: BoardItem[];
  crews: { id: string; name: string }[];
  jobTypes: { code: string | null; label: string; count: number }[];
  sync: { startedAt: string; finishedAt: string | null; status: string } | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRange(from: unknown, to: unknown): { from: string; to: string } | { error: string } {
  if (typeof from !== "string" || !DATE_RE.test(from)) return { error: "from must be YYYY-MM-DD" };
  if (typeof to !== "string" || !DATE_RE.test(to)) return { error: "to must be YYYY-MM-DD" };
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return { error: "invalid date" };
  if (b < a) return { error: "to must not be before from" };
  if ((b - a) / 86_400_000 > MAX_RANGE_DAYS) return { error: `range may not exceed ${MAX_RANGE_DAYS} days` };
  return { from, to };
}

/** Today's date in the office's time zone. */
export function todayInBoardZone(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: BOARD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

interface Row {
  id: string; jp_schedule_id: string; jp_job_id: string | null; jp_customer_id: string | null;
  title: string | null; description: string | null; start_at: Date; end_at: Date;
  full_day: boolean; is_completed: boolean; job_type_code: string | null;
  job_number: string | null; job_name: string | null; job_stage: string | null; job_insurance: boolean | null;
  customer_name: string | null; crew_ids: string[]; crew_names: string[]; trades: string[]; work_types: string[];
  jp_updated_at: Date | null;
  start_day: string; end_day: string; start_time: string; end_time: string;
  address: string | null; address_line_1: string | null; city: string | null; state: string | null;
  zip: string | null; lat: number | null; lng: number | null;
  stage: string | null; stage_code: string | null;
}

export function jobProgressUrl(customerId: string | null, jobId: string | null): string | null {
  if (!customerId || !jobId) return null;
  return `https://app.jobprogress.com/#/customer-jobs/${encodeURIComponent(customerId)}/job/${encodeURIComponent(jobId)}/overview`;
}

function toItem(r: Row): BoardItem {
  const crews = r.crew_ids.map((id, i) => ({ id, name: r.crew_names[i] ?? id }));
  // Crew names can exist without ids on older rows; keep them visible.
  for (let i = crews.length; i < r.crew_names.length; i++) crews.push({ id: r.crew_names[i]!, name: r.crew_names[i]! });
  const hasLocation = r.address !== null || r.lat !== null;
  return {
    id: r.id,
    jpScheduleId: r.jp_schedule_id,
    jobId: r.jp_job_id,
    customerId: r.jp_customer_id,
    title: r.title,
    description: r.description,
    parsed: parseScheduleTitle(r.title),
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    startDay: r.start_day,
    endDay: r.end_day,
    startTime: r.start_time,
    endTime: r.end_time,
    fullDay: r.full_day,
    multiDay: r.start_day !== r.end_day,
    isCompleted: r.is_completed,
    status: scheduleStatus({ is_completed: r.is_completed, crews: r.crew_names }),
    jobNumber: r.job_number,
    jobName: r.job_name,
    jobStage: r.job_stage,
    insurance: r.job_insurance,
    customerName: r.customer_name,
    crews,
    trades: r.trades,
    workTypes: r.work_types,
    location: hasLocation ? {
      address: r.address, addressLine1: r.address_line_1, city: r.city, state: r.state, zip: r.zip,
      lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng),
    } : null,
    jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
    jpUpdatedAt: r.jp_updated_at ? r.jp_updated_at.toISOString() : null,
    stage: r.stage,
    stageCode: r.stage_code,
  };
}

export async function boardForRange(ctx: SessionContext, from: string, to: string): Promise<Board> {
  const rows = await withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT s.id, s.jp_schedule_id, s.jp_job_id, s.jp_customer_id, s.title, s.description,
              s.start_at, s.end_at, s.full_day, s.is_completed, s.job_type_code,
              s.job_number, s.job_name, s.job_stage, s.job_insurance, s.customer_name,
              s.crew_ids, s.crew_names, s.trades, s.work_types, s.jp_updated_at,
              (s.start_at AT TIME ZONE $3)::date::text AS start_day,
              (s.end_at   AT TIME ZONE $3)::date::text AS end_day,
              to_char(s.start_at AT TIME ZONE $3, 'HH24:MI') AS start_time,
              to_char(s.end_at   AT TIME ZONE $3, 'HH24:MI') AS end_time,
              l.address, l.address_line_1, l.city, l.state, l.zip, l.lat, l.lng,
              j.current_stage AS stage, j.stage_code
         FROM jp_schedule s
         LEFT JOIN jp_job_location l ON l.jp_job_id = s.jp_job_id
         LEFT JOIN jp_job j ON j.jp_job_id = s.jp_job_id
        WHERE s.deleted_at IS NULL
          AND (s.start_at AT TIME ZONE $3)::date <= $2::date
          AND (s.end_at   AT TIME ZONE $3)::date >= $1::date
        ORDER BY s.start_at, s.title`,
      [from, to, BOARD_TIMEZONE]);
    return rows;
  });

  const items = rows.map(toItem);

  const crewMap = new Map<string, string>();
  for (const it of items) for (const c of it.crews) crewMap.set(c.id, c.name);
  const crews = [...crewMap].map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const typeMap = new Map<string, { code: string | null; label: string; count: number }>();
  for (const it of items) {
    const key = it.parsed.code ?? "";
    const cur = typeMap.get(key) ?? { code: it.parsed.code, label: it.parsed.label, count: 0 };
    cur.count++;
    typeMap.set(key, cur);
  }
  const jobTypes = [...typeMap.values()].sort((a, b) => b.count - a.count);

  const sync = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ started_at: Date; finished_at: Date | null; status: string }>(
      `SELECT started_at, finished_at, status FROM sync_run
        WHERE kind = 'schedules' ORDER BY started_at DESC LIMIT 1`);
    const r = rows[0];
    return r ? {
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
      status: r.status,
    } : null;
  }, "production:board-freshness", { quiet: true });

  return { from, to, timezone: BOARD_TIMEZONE, items, crews, jobTypes, sync };
}
