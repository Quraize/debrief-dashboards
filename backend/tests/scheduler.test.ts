/**
 * pg-boss wiring: queue policy, schedule reconciliation in both directions,
 * the worker's failure translation, the advisory-lock overlap guard, and the
 * backfill enqueue path.
 *
 * The worker's polling is set slow for most tests so jobs stay put while we
 * assert on them; one test runs the real polling loop end to end.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import type { SyncResult, SyncCounts } from "../src/jobs/syncJobProgress.js";

const reachable = await pgReachable();
requirePg(reachable);

let db: TestDb;
let scheduler: typeof import("../src/jobs/scheduler.js");

const fakeResult = (over: Partial<SyncResult> = {}): SyncResult => ({
  syncRunId: "fake",
  mode: "commit",
  status: "completed",
  counts: { created: 1 } as SyncCounts,
  conflicts: [],
  incrementalSince: null,
  ...over,
});

describe.skipIf(!reachable)("scheduler", () => {
  beforeAll(async () => {
    db = await createTestDb("sched");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
    delete process.env.SYNC_SCHEDULE_ENABLED;
    process.env.SYNC_POLL_SECONDS = "120"; // keep the worker's hands off queued jobs
    scheduler = await import("../src/jobs/scheduler.js");
  });
  afterAll(async () => {
    await scheduler?.stopScheduler({ graceful: false });
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
    delete process.env.SYNC_SCHEDULE_ENABLED;
    delete process.env.SYNC_POLL_SECONDS;
    delete process.env.SYNC_SCHEDULE_CRON;
  });

  it("starts with a singleton queue and, disabled by default, no schedule", async () => {
    await scheduler.startScheduler();
    const boss = scheduler.getBoss()!;
    const queue = await boss.getQueue(scheduler.SYNC_QUEUE);
    expect(queue?.policy, "the singleton policy IS the mutual exclusion").toBe("singleton");
    expect(await boss.getSchedules()).toEqual([]);
  });

  it("registers the cron schedule when enabled, and removes it again when disabled", async () => {
    await scheduler.stopScheduler({ graceful: false });
    process.env.SYNC_SCHEDULE_ENABLED = "true";
    process.env.SYNC_SCHEDULE_CRON = "0 11,16,20,23 * * *";
    await scheduler.startScheduler();
    const schedules = await scheduler.getBoss()!.getSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ name: scheduler.SYNC_QUEUE, cron: "0 11,16,20,23 * * *" });

    // pg-boss persists schedule rows; flipping the env off must remove it.
    await scheduler.stopScheduler({ graceful: false });
    process.env.SYNC_SCHEDULE_ENABLED = "false";
    await scheduler.startScheduler();
    expect(await scheduler.getBoss()!.getSchedules()).toEqual([]);
  });

  it("returns counts from a successful scheduled run", async () => {
    const out = await scheduler.handleSyncJob(
      { id: "j1", data: { kind: "incremental" } },
      { runSync: async () => fakeResult() },
    );
    expect(out).toMatchObject({ created: 1 });
  });

  it("translates a failed sync result into a throw, so pg-boss retries it", async () => {
    // runJobProgressSync reports failure as a VALUE (its telemetry row is
    // already written); without this translation pg-boss would mark the job
    // completed and never retry.
    await expect(scheduler.handleSyncJob(
      { id: "j2", data: { kind: "incremental" } },
      { runSync: async () => fakeResult({ status: "failed", errorMessage: "upstream exploded" }) },
    )).rejects.toThrow(/upstream exploded/);
  });

  it("dispatches a backfill job to runBackfill inside the same lock", async () => {
    const seen: unknown[] = [];
    const out = await scheduler.handleSyncJob(
      { id: "j3", data: { kind: "backfill", mode: "commit", dateFrom: "2026-01-01", dateTo: "2026-01-31" } },
      { runBackfillFn: async (opts) => { seen.push(opts); return { mode: "commit", chunks: 1, skipped: 0, ran: 1, syncRunIds: [] }; } },
    );
    expect(out).toMatchObject({ chunks: 1 });
    expect(seen[0]).toMatchObject({ mode: "commit", dateFrom: "2026-01-01", dateTo: "2026-01-31" });
  });

  it("refuses to run while another sync holds the lock, and records the overlap", async () => {
    const holder = await db.jobs.connect();
    try {
      await holder.query("SELECT pg_advisory_lock($1)", [scheduler.SYNC_LOCK_KEY]);
      await expect(scheduler.handleSyncJob(
        { id: "j4", data: { kind: "incremental" } },
        { runSync: async () => fakeResult() },
      )).rejects.toThrow(/already running/);
      const { rows } = await db.owner.query(
        `SELECT reason FROM sync_conflict WHERE category = 'overlapping_run'`);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [scheduler.SYNC_LOCK_KEY]);
      holder.release();
    }
  });

  it("releases the lock after a run, success or failure", async () => {
    await expect(scheduler.handleSyncJob(
      { id: "j5", data: { kind: "incremental" } },
      { runSync: async () => { throw new Error("boom"); } },
    )).rejects.toThrow("boom");
    // If the lock leaked, this second run would 409 instead of succeeding.
    const out = await scheduler.handleSyncJob(
      { id: "j6", data: { kind: "incremental" } },
      { runSync: async () => fakeResult() },
    );
    expect(out).toMatchObject({ created: 1 });
  });

  it("queues a backfill and refuses a duplicate with 409", async () => {
    const queued = await scheduler.enqueueBackfill({
      mode: "dry_run", dateFrom: "2026-01-01", dateTo: "2026-02-15", startedBy: "test",
    });
    expect(queued.jobId).toBeTruthy();
    expect(queued.chunks).toBe(2);

    await expect(scheduler.enqueueBackfill({
      mode: "dry_run", dateFrom: "2026-01-01", dateTo: "2026-02-15", startedBy: "test",
    })).rejects.toMatchObject({ statusCode: 409 });

    // Visible to the status endpoint while queued.
    const status = await scheduler.syncStatus();
    expect(status.backfill.active).toBe(true);
    expect(status.backfill.progress).toMatchObject({ total: 2 });
  });

  it("processes a queued job through the real polling loop", async () => {
    // End-to-end through pg-boss: no LEAP_API_TOKEN is set in the test env, so
    // the handler throws inside the worker and the job must land `failed` —
    // proving the poll → handler → failure-translation path without any API.
    delete process.env.LEAP_API_TOKEN;
    await scheduler.stopScheduler({ graceful: false });
    process.env.SYNC_POLL_SECONDS = "1";
    await scheduler.startScheduler();
    const boss = scheduler.getBoss()!;

    // Clear the queued backfill from the previous test so this job runs next.
    await db.jobs.query(`DELETE FROM pgboss.job WHERE name = $1 AND state = 'created'`, [scheduler.SYNC_QUEUE]);

    const jobId = await boss.send(scheduler.SYNC_QUEUE,
      { kind: "incremental" }, { retryLimit: 0, expireInSeconds: 60 });
    expect(jobId).toBeTruthy();

    await expect.poll(async () => {
      const { rows } = await db.jobs.query<{ state: string }>(
        `SELECT state FROM pgboss.job WHERE id = $1`, [jobId]);
      return rows[0]?.state;
    }, { timeout: 15_000, interval: 500 }).toBe("failed");

    const { rows } = await db.jobs.query<{ output: { message?: string } | null }>(
      `SELECT output FROM pgboss.job WHERE id = $1`, [jobId]);
    expect(JSON.stringify(rows[0]!.output)).toMatch(/LEAP_API_TOKEN/);
  }, 30_000);
});
