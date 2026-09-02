/**
 * Job scheduling — pg-boss wiring (MIGRATION_PLAN.md §4.3).
 *
 * One queue, `leap-sync`, carries both the 4×/day incremental sync and the
 * one-shot historical backfill. The queue's `singleton` policy is the mutual
 * exclusion: at most one job in it is ever active, so a backfill and a
 * scheduled sync can queue behind each other but never overlap.
 *
 * A second, independent guard — a Postgres advisory lock — covers the path
 * pg-boss cannot see: the manual sync triggered from the admin UI runs in the
 * request, not on the queue. Every sync path goes through `runSyncExclusive`,
 * so two of them can never interleave writes no matter how they were started.
 *
 * The cron schedule is registered in UTC on purpose (§4.3's DST warning): the
 * default fires 11:00/16:00/20:00/23:00 UTC — 7a/12p/4p/7p in New York during
 * daylight time, an hour earlier in winter. Scheduling stays DISABLED until
 * `SYNC_SCHEDULE_ENABLED=true`, which the runbook sets only after a clean
 * manual commit run.
 */
import PgBoss from "pg-boss";
import { dbJobs, withServiceRole } from "../db/client.js";
import { runJobProgressSync, type SyncMode } from "./syncJobProgress.js";
import { runBackfill, monthChunks, type BackfillResult } from "./backfill.js";

export const SYNC_QUEUE = "leap-sync";
/** Session advisory lock guarding every sync path. 40172026 is the migration
 *  runner's lock; this is deliberately adjacent but distinct. */
export const SYNC_LOCK_KEY = 40172027;

const INCREMENTAL_JOB_OPTS: PgBoss.SendOptions = {
  retryLimit: 2,
  retryDelay: 600,
  retryBackoff: true,
  expireInSeconds: 3600,
};

const BACKFILL_JOB_OPTS: PgBoss.SendOptions = {
  retryLimit: 3,
  retryDelay: 300,
  retryBackoff: true,
  // A full-year backfill is tens of minutes at the API's rate limit; six hours
  // is the hang backstop, not an expected runtime.
  expireInSeconds: 21_600,
};

export interface SyncJobData {
  kind: "incremental" | "backfill";
  mode?: SyncMode;
  dateFrom?: string;
  dateTo?: string;
  startedBy?: string;
}

let boss: PgBoss | null = null;
let lastOptions: SchedulerOptions = {};
let watchdog: NodeJS.Timeout | null = null;
let restarting = false;
let lastWatchdogRestart = 0;

const WATCHDOG_INTERVAL_MS = 2 * 60_000;
/** cron_on updates every ~30s on a healthy timekeeper; 10 min is decisively dead. */
const CRON_STALE_MS = 10 * 60_000;
const RESTART_COOLDOWN_MS = 5 * 60_000;

export function getBoss(): PgBoss | null {
  return boss;
}

function httpError(message: string, statusCode: number): Error {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

/**
 * Runs `fn` holding the sync advisory lock, or refuses with a recorded
 * `overlapping_run` conflict. try-lock rather than wait: a sync that queues
 * silently behind another can double a window nobody asked for — the caller
 * (pg-boss retry, the next cron tick, or the admin) decides when to try again.
 */
export async function runSyncExclusive<T>(fn: () => Promise<T>, who: string): Promise<T> {
  const client = await dbJobs().connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked", [SYNC_LOCK_KEY]);
    if (!rows[0]!.locked) {
      await withServiceRole(async (c) => {
        await c.query(
          `INSERT INTO sync_conflict (category, reason) VALUES ('overlapping_run', $1)`,
          [`${who} skipped: another sync holds the lock`]);
      }, "scheduler:overlap", { quiet: true });
      throw httpError(`Another sync is already running; ${who} was not started.`, 409);
    }
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [SYNC_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

/**
 * The queue worker. Exported so tests can invoke it directly instead of
 * waiting on the poller; `deps` is a DI seam for the same reason.
 *
 * `runJobProgressSync` reports failure as a value (so its telemetry row is
 * always written); pg-boss only retries on a THROW, so the translation here is
 * load-bearing — without it a failed sync would be marked completed.
 */
export async function handleSyncJob(
  job: { id: string; data: SyncJobData },
  deps: { runSync?: typeof runJobProgressSync; runBackfillFn?: typeof runBackfill } = {},
): Promise<unknown> {
  const runSync = deps.runSync ?? runJobProgressSync;
  const data = job.data ?? { kind: "incremental" };

  if (data.kind === "backfill") {
    const backfill = deps.runBackfillFn ?? runBackfill;
    return runSyncExclusive(
      () => backfill({
        mode: data.mode ?? "dry_run",
        dateFrom: data.dateFrom ?? "2026-01-01",
        dateTo: data.dateTo ?? new Date().toISOString().slice(0, 10),
        startedBy: data.startedBy ?? `backfill:${job.id}`,
        runSync,
      }),
      `backfill:${job.id}`);
  }

  const result = await runSyncExclusive(
    () => runSync({ mode: "commit", startedBy: data.startedBy ?? "scheduler" }),
    "scheduler");
  if (result.status === "failed") {
    throw new Error(result.errorMessage ?? "sync failed");
  }
  return result.counts;
}

/**
 * Marks abandoned runs. A crash mid-sync leaves a `running` row forever, and a
 * stale one both lies on the admin page and (worse) would make an overlap guard
 * based on rows unusable — which is exactly why the guard uses a lock instead.
 */
async function sweepStaleSyncRuns(): Promise<void> {
  await withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE sync_run SET status = 'timeout', finished_at = now()
        WHERE status = 'running' AND started_at < now() - interval '24 hours'`);
    if (rowCount) console.warn(`[scheduler] marked ${rowCount} abandoned sync_run row(s) as timeout`);
  }, "scheduler:sweep-stale", { quiet: true });
}

export interface SchedulerOptions {
  /** Register the queue worker (tests disable it to control timing). */
  worker?: boolean;
}

export async function startScheduler(options: SchedulerOptions = {}): Promise<void> {
  if (boss) throw new Error("scheduler already started");
  lastOptions = options;
  const connectionString = process.env.DATABASE_URL_JOBS ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL_JOBS (or DATABASE_URL) must be set before the scheduler starts");
  }

  const instance = new PgBoss({
    connectionString,
    schema: "pgboss",
    max: 3,
    application_name: "allied-pgboss",
    // pg-boss guards its cron and maintenance loops with a re-entrancy flag
    // that is only cleared when the in-flight DB promise settles. A query or
    // pool checkout that hangs forever therefore latches BOTH loops off,
    // silently — observed in production. These flow through to pg.Pool /
    // pg.Client and guarantee every promise settles.
    connectionTimeoutMillis: 15_000,
    query_timeout: 60_000,
    statement_timeout: 60_000,
  } as PgBoss.ConstructorOptions);
  // Without a handler pg-boss's EventEmitter turns a transient maintenance
  // error into a process crash.
  instance.on("error", (err) => console.error("[pgboss]", err));
  await instance.start();
  boss = instance;

  await sweepStaleSyncRuns();

  // Reconcile the queue: created on first boot, policy re-asserted on later
  // ones so a manual edit cannot quietly remove the mutual exclusion.
  const existing = await instance.getQueue(SYNC_QUEUE);
  if (!existing) {
    await instance.createQueue(SYNC_QUEUE, { name: SYNC_QUEUE, policy: "singleton" });
  } else if (existing.policy !== "singleton") {
    await instance.updateQueue(SYNC_QUEUE, { name: SYNC_QUEUE, policy: "singleton" });
  }

  // Reconcile the schedule in BOTH directions: pg-boss persists schedule rows
  // until unschedule() is called, so flipping the env var off must actively
  // remove the row, not merely stop adding it.
  const enabled = process.env.SYNC_SCHEDULE_ENABLED === "true";
  const cron = process.env.SYNC_SCHEDULE_CRON ?? "0 11,16,20,23 * * *";
  if (enabled) {
    await instance.schedule(SYNC_QUEUE, cron,
      { kind: "incremental", startedBy: "scheduler" } satisfies SyncJobData,
      { ...INCREMENTAL_JOB_OPTS, tz: "UTC" });
    console.info(`[scheduler] ${SYNC_QUEUE} scheduled: "${cron}" (UTC)`);
  } else {
    await instance.unschedule(SYNC_QUEUE);
    console.info("[scheduler] scheduled sync disabled (set SYNC_SCHEDULE_ENABLED=true after a clean manual run)");
  }

  if (options.worker !== false) {
    await instance.work<SyncJobData>(
      SYNC_QUEUE,
      { pollingIntervalSeconds: Number(process.env.SYNC_POLL_SECONDS ?? 5) },
      async ([job]) => handleSyncJob(job!),
    );
  }

  // Liveness watchdog: checked through OUR pool, not pg-boss's, so it works
  // precisely when pg-boss's own plumbing is what died. unref() keeps it from
  // holding the process open.
  if (!watchdog) {
    watchdog = setInterval(() => {
      void checkSchedulerLiveness().catch((err) => console.error("[scheduler] watchdog check failed", err));
    }, WATCHDOG_INTERVAL_MS);
    watchdog.unref();
  }
}

/**
 * Restarts pg-boss when its cron heartbeat (pgboss.version.cron_on, written
 * every ~30s by a healthy timekeeper) goes stale. Belt to the timeout
 * suspenders above: whatever silently kills the internal loops, the scheduler
 * heals itself instead of skipping ticks until someone notices.
 */
export async function checkSchedulerLiveness(): Promise<"ok" | "restarted" | "skipped"> {
  if (restarting) return "skipped";
  if (Date.now() - lastWatchdogRestart < RESTART_COOLDOWN_MS) return "skipped";

  // No instance at all with a live watchdog means a previous restart failed
  // partway (e.g. the DB was briefly unreachable) — keep trying to come back.
  if (!boss) {
    restarting = true;
    lastWatchdogRestart = Date.now();
    try {
      await startScheduler(lastOptions);
      console.info("[scheduler] watchdog: scheduler recovered after a failed restart");
      return "restarted";
    } finally {
      restarting = false;
    }
  }

  const stale = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ stale: boolean }>(
      `SELECT cron_on IS NULL OR cron_on < now() - $1::interval AS stale FROM pgboss.version`,
      [`${CRON_STALE_MS} milliseconds`]);
    return rows[0]?.stale ?? false;
  }, "scheduler:watchdog", { quiet: true });
  if (!stale) return "ok";

  restarting = true;
  lastWatchdogRestart = Date.now();
  console.error("[scheduler] watchdog: pg-boss cron heartbeat is stale — restarting the scheduler");
  try {
    const instance = boss;
    boss = null;
    // Not graceful: a wedged instance is exactly what we're replacing.
    await instance.stop({ graceful: false, wait: true, timeout: 5_000, close: true })
      .catch((err) => console.error("[scheduler] watchdog: stop of wedged instance failed", err));
    await startScheduler(lastOptions);
    console.info("[scheduler] watchdog: scheduler restarted");
    return "restarted";
  } finally {
    restarting = false;
  }
}

export async function stopScheduler(options: { graceful?: boolean } = {}): Promise<void> {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (!boss) return;
  const instance = boss;
  boss = null;
  await instance.stop({
    graceful: options.graceful ?? true,
    wait: true,
    timeout: Number(process.env.SYNC_SHUTDOWN_TIMEOUT_MS ?? 20_000),
    close: true,
  });
}

/**
 * Queues a backfill. 409 when one is already queued or running — re-triggering
 * mid-flight would only queue a duplicate sweep behind the current one.
 */
export async function enqueueBackfill(data: {
  mode: SyncMode; dateFrom: string; dateTo: string; startedBy: string;
}): Promise<{ jobId: string; chunks: number }> {
  if (!boss) throw httpError("The job scheduler is not running.", 503);

  const chunks = monthChunks(data.dateFrom, data.dateTo);
  if (chunks.length === 0) {
    throw httpError(`Invalid backfill window: ${data.dateFrom} → ${data.dateTo}`, 400);
  }

  const { rows } = await dbJobs().query(
    `SELECT id FROM pgboss.job
      WHERE name = $1 AND state IN ('created','retry','active')
        AND data->>'kind' = 'backfill'
      LIMIT 1`, [SYNC_QUEUE]);
  if (rows.length > 0) {
    throw httpError("A backfill is already queued or running. Check Sync Runs for its progress.", 409);
  }

  const jobId = await boss.send(SYNC_QUEUE,
    { kind: "backfill", ...data } satisfies SyncJobData, BACKFILL_JOB_OPTS);
  if (!jobId) {
    // send() returns null only when the queue row is missing — a broken boot.
    throw new Error(`Could not enqueue: queue ${SYNC_QUEUE} does not exist`);
  }
  console.info(`[scheduler] backfill queued: ${data.mode} ${data.dateFrom} → ${data.dateTo} (job ${jobId})`);
  return { jobId, chunks: chunks.length };
}

export interface SyncStatus {
  schedule: { enabled: boolean; cron: string; timezone: "UTC" };
  lastScheduledRun: { started_at: string; finished_at: string | null; status: string } | null;
  backfill: {
    active: boolean;
    jobId?: string;
    mode?: string;
    dateFrom?: string;
    dateTo?: string;
    progress?: { total: number; completed: number };
  };
}

/** What the admin page's status bar shows instead of hardcoded text. */
export async function syncStatus(): Promise<SyncStatus> {
  const lastScheduledRun = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ started_at: Date; finished_at: Date | null; status: string }>(
      `SELECT started_at, finished_at, status FROM sync_run
        WHERE started_by = 'scheduler'
        ORDER BY started_at DESC LIMIT 1`);
    const row = rows[0];
    if (!row) return null;
    return {
      started_at: row.started_at.toISOString(),
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
      status: row.status,
    };
  }, "scheduler:status", { quiet: true });

  let backfill: SyncStatus["backfill"] = { active: false };
  if (boss) {
    const { rows } = await dbJobs().query<{ id: string; data: SyncJobData }>(
      `SELECT id, data FROM pgboss.job
        WHERE name = $1 AND state IN ('created','retry','active')
          AND data->>'kind' = 'backfill'
        LIMIT 1`, [SYNC_QUEUE]);
    const job = rows[0];
    if (job) {
      const { backfillProgress } = await import("./backfill.js");
      const mode = (job.data.mode ?? "dry_run") as SyncMode;
      const dateFrom = job.data.dateFrom ?? "2026-01-01";
      const dateTo = job.data.dateTo ?? new Date().toISOString().slice(0, 10);
      backfill = {
        active: true,
        jobId: job.id,
        mode,
        dateFrom,
        dateTo,
        progress: await backfillProgress(mode, dateFrom, dateTo),
      };
    }
  }

  return {
    schedule: {
      enabled: process.env.SYNC_SCHEDULE_ENABLED === "true",
      cron: process.env.SYNC_SCHEDULE_CRON ?? "0 11,16,20,23 * * *",
      timezone: "UTC",
    },
    lastScheduledRun,
    backfill,
  };
}
