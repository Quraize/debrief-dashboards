/**
 * Historical backfill: chunking arithmetic (pure) and resume-by-telemetry
 * (against a real database, since the skip decision is a sync_run query).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, pgReachable, requirePg, type TestDb } from "./helpers/db.js";
import { monthChunks, runBackfill, backfillProgress } from "../src/jobs/backfill.js";
import type { SyncOptions, SyncResult, SyncCounts } from "../src/jobs/syncJobProgress.js";

const reachable = await pgReachable();
requirePg(reachable);

let db: TestDb;

const fakeResult = (over: Partial<SyncResult> = {}): SyncResult => ({
  syncRunId: "fake",
  mode: "commit",
  status: "completed",
  counts: { api_appointments_examined: 0, created: 0 } as SyncCounts,
  conflicts: [],
  incrementalSince: null,
  ...over,
});

describe("monthChunks", () => {
  it("splits a range into calendar months, clamping the first and last", () => {
    expect(monthChunks("2026-01-15", "2026-03-10")).toEqual([
      { dateFrom: "2026-01-15", dateTo: "2026-01-31" },
      { dateFrom: "2026-02-01", dateTo: "2026-02-28" },
      { dateFrom: "2026-03-01", dateTo: "2026-03-10" },
    ]);
  });

  it("handles a range inside a single month, including a single day", () => {
    expect(monthChunks("2026-08-05", "2026-08-20")).toEqual([
      { dateFrom: "2026-08-05", dateTo: "2026-08-20" },
    ]);
    expect(monthChunks("2026-08-05", "2026-08-05")).toEqual([
      { dateFrom: "2026-08-05", dateTo: "2026-08-05" },
    ]);
  });

  it("crosses a year boundary", () => {
    expect(monthChunks("2025-12-01", "2026-01-31")).toEqual([
      { dateFrom: "2025-12-01", dateTo: "2025-12-31" },
      { dateFrom: "2026-01-01", dateTo: "2026-01-31" },
    ]);
  });

  it("covers a full year in twelve chunks — the 2026 backfill shape", () => {
    const chunks = monthChunks("2026-01-01", "2026-12-31");
    expect(chunks).toHaveLength(12);
    expect(chunks[1]).toEqual({ dateFrom: "2026-02-01", dateTo: "2026-02-28" });
  });

  it("returns [] for an inverted or malformed range instead of looping", () => {
    expect(monthChunks("2026-03-01", "2026-01-01")).toEqual([]);
    expect(monthChunks("not-a-date", "2026-01-01")).toEqual([]);
    expect(monthChunks("", "")).toEqual([]);
  });
});

describe.skipIf(!reachable)("runBackfill", () => {
  beforeAll(async () => {
    db = await createTestDb("backfill");
    const admin = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/postgres";
    const host = admin.replace(/^postgres:\/\/[^@]*@/, "").replace(/\/[^/]*$/, "");
    process.env.DATABASE_URL_JOBS = `postgres://allied_jobs:dev_jobs@${host}/${db.name}`;
  });
  afterAll(async () => {
    const { closePools } = await import("../src/db/client.js");
    await closePools();
    await db?.drop();
  });

  const seedCompletedChunk = (mode: string, from: string, to: string) =>
    db.owner.query(
      `INSERT INTO sync_run (mode, status, date_from, date_to, full_backfill, finished_at)
       VALUES ($1, 'completed', $2, $3, true, now())`, [mode, from, to]);

  it("runs every chunk once and threads fullBackfill through to the sync", async () => {
    const calls: SyncOptions[] = [];
    const result = await runBackfill({
      mode: "commit", dateFrom: "2026-05-01", dateTo: "2026-06-30", startedBy: "test",
      runSync: async (options) => { calls.push(options); return fakeResult(); },
    });
    expect(result).toMatchObject({ chunks: 2, skipped: 0, ran: 2 });
    expect(calls.map((c) => [c.dateFrom, c.dateTo])).toEqual([
      ["2026-05-01", "2026-05-31"],
      ["2026-06-01", "2026-06-30"],
    ]);
    expect(calls.every((c) => c.fullBackfill === true), "occurrence windows require fullBackfill").toBe(true);
    expect(calls.every((c) => c.mode === "commit")).toBe(true);
  });

  it("resumes by skipping chunks that already completed — the crash-recovery path", async () => {
    await seedCompletedChunk("commit", "2026-01-01", "2026-01-31");
    const calls: SyncOptions[] = [];
    const result = await runBackfill({
      mode: "commit", dateFrom: "2026-01-01", dateTo: "2026-02-28",
      runSync: async (options) => { calls.push(options); return fakeResult(); },
    });
    expect(result.skipped).toBe(1);
    expect(calls.map((c) => c.dateFrom)).toEqual(["2026-02-01"]);
  });

  it("does not let a dry-run preview mask a commit chunk", async () => {
    await seedCompletedChunk("dry_run", "2026-03-01", "2026-03-31");
    const calls: SyncOptions[] = [];
    await runBackfill({
      mode: "commit", dateFrom: "2026-03-01", dateTo: "2026-03-31",
      runSync: async (options) => { calls.push(options); return fakeResult(); },
    });
    expect(calls, "the dry_run row must not satisfy a commit backfill").toHaveLength(1);
  });

  it("throws on a failed chunk and stops, so the pg-boss retry policy applies", async () => {
    const calls: string[] = [];
    await expect(runBackfill({
      mode: "commit", dateFrom: "2026-07-01", dateTo: "2026-09-30",
      runSync: async (options) => {
        calls.push(options.dateFrom!);
        return options.dateFrom === "2026-08-01"
          ? fakeResult({ status: "failed", errorMessage: "upstream exploded" })
          : fakeResult();
      },
    })).rejects.toThrow(/2026-08-01 → 2026-08-31 failed: upstream exploded/);
    expect(calls, "chunks after the failure must not run").toEqual(["2026-07-01", "2026-08-01"]);
  });

  it("rejects an invalid window outright", async () => {
    await expect(runBackfill({
      mode: "commit", dateFrom: "2026-09-01", dateTo: "2026-01-01",
      runSync: async () => fakeResult(),
    })).rejects.toThrow(/invalid/);
  });

  it("reports progress as completed chunks over total", async () => {
    // January was seeded completed above; February/March were not.
    const progress = await backfillProgress("commit", "2026-01-01", "2026-03-31");
    expect(progress.total).toBe(3);
    expect(progress.completed).toBeGreaterThanOrEqual(1);
  });
});
