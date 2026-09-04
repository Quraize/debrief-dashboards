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
import { mapJpJob, upsertJpRows } from "../jobs/syncJobProgress.js";
import { parseApiTimestamp } from "./syncSchedules.js";
import { isTrackedStage } from "@allied/shared/jobStages";

export interface StageSyncCounts {
  stages_examined: number;
  stages_tracked: number;
  jobs_examined: number;
  jobs_upserted: number;
  jobs_moved_out: number;
  locations_fetched: number;
  api_requests: number;
  retries: number;
  rate_limit_hits: number;
  errors: number;
}

export interface StageSyncOptions { startedBy?: string; client?: JobProgressClient }
export interface StageSyncResult {
  syncRunId: string; status: "completed" | "failed"; counts: StageSyncCounts; errorMessage?: string;
}

const emptyCounts = (): StageSyncCounts => ({
  stages_examined: 0, stages_tracked: 0, jobs_examined: 0, jobs_upserted: 0, jobs_moved_out: 0,
  locations_fetched: 0, api_requests: 0, retries: 0, rate_limit_hits: 0, errors: 0,
});

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
