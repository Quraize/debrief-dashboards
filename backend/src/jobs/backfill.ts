/**
 * Historical JobProgress backfill.
 *
 * Sweeps a date range (2026-01-01 → today by default) through the existing
 * idempotent sync core, one calendar month at a time. Chunking is what keeps
 * this production-safe:
 *
 *  * memory is bounded — the client buffers a month (~120 appointments), not a
 *    year;
 *  * every chunk writes its own `sync_run` row, so the admin UI shows progress
 *    as it happens;
 *  * resume is derived from that same telemetry: a chunk with a completed
 *    commit run for exactly its window is skipped. No checkpoint column, no
 *    second source of truth — the worst case after a crash is re-running one
 *    idempotent chunk.
 *
 * A failed chunk throws, which fails the whole pg-boss job; the retry re-enters
 * here and skips everything already completed.
 */
import { withServiceRole } from "../db/client.js";
import {
  runJobProgressSync, type SyncMode, type SyncOptions, type SyncResult,
} from "./syncJobProgress.js";

export interface Chunk { dateFrom: string; dateTo: string }

export interface BackfillOptions {
  mode: SyncMode;
  dateFrom: string;
  dateTo: string;
  startedBy?: string;
  /** DI seam for tests; defaults to the real sync. */
  runSync?: (options: SyncOptions) => Promise<SyncResult>;
}

export interface BackfillResult {
  mode: SyncMode;
  chunks: number;
  skipped: number;
  ran: number;
  syncRunIds: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Calendar-month windows clamped to [dateFrom, dateTo]. Pure string arithmetic
 * — no Date-at-local-midnight surprises across timezones.
 */
export function monthChunks(dateFrom: string, dateTo: string): Chunk[] {
  const from = String(dateFrom).slice(0, 10);
  const to = String(dateTo).slice(0, 10);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return [];

  const pad = (n: number) => String(n).padStart(2, "0");
  const chunks: Chunk[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  for (;;) {
    const monthStart = `${year}-${pad(month)}-01`;
    const monthEnd = `${year}-${pad(month)}-${pad(new Date(year, month, 0).getDate())}`;
    chunks.push({
      dateFrom: monthStart < from ? from : monthStart,
      dateTo: monthEnd > to ? to : monthEnd,
    });
    if (monthEnd >= to) break;
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return chunks;
}

/**
 * True when a chunk already has a completed run for exactly this window and
 * mode. Mode matters: a dry-run preview must never mask a commit chunk.
 */
async function chunkCompleted(mode: SyncMode, chunk: Chunk): Promise<boolean> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query(
      `SELECT 1 FROM sync_run
        WHERE status = 'completed' AND mode = $1 AND full_backfill
          AND date_from = $2 AND date_to = $3
        LIMIT 1`,
      [mode, chunk.dateFrom, chunk.dateTo]);
    return rows.length > 0;
  }, "backfill:chunk-check", { quiet: true });
}

/** Completed-vs-total chunk counts for a window — the admin UI's progress bar. */
export async function backfillProgress(
  mode: SyncMode, dateFrom: string, dateTo: string,
): Promise<{ total: number; completed: number }> {
  const chunks = monthChunks(dateFrom, dateTo);
  let completed = 0;
  for (const chunk of chunks) {
    if (await chunkCompleted(mode, chunk)) completed++;
  }
  return { total: chunks.length, completed };
}

export async function runBackfill(options: BackfillOptions): Promise<BackfillResult> {
  const chunks = monthChunks(options.dateFrom, options.dateTo);
  if (chunks.length === 0) {
    throw new Error(`Backfill window is invalid: ${options.dateFrom} → ${options.dateTo}`);
  }
  const run = options.runSync ?? runJobProgressSync;

  let skipped = 0;
  const syncRunIds: string[] = [];
  for (const chunk of chunks) {
    if (await chunkCompleted(options.mode, chunk)) {
      skipped++;
      continue;
    }
    const result = await run({
      mode: options.mode,
      dateFrom: chunk.dateFrom,
      dateTo: chunk.dateTo,
      fullBackfill: true,
      startedBy: options.startedBy,
    });
    syncRunIds.push(result.syncRunId);
    if (result.status === "failed") {
      // The sync records its own failure; rethrowing makes the pg-boss job
      // fail too, so its retry policy applies and the next attempt resumes
      // from the completed-chunk telemetry.
      throw new Error(
        `Backfill chunk ${chunk.dateFrom} → ${chunk.dateTo} failed: ${result.errorMessage ?? "unknown error"}`);
    }
    console.info(
      `[backfill] ${options.mode} ${chunk.dateFrom} → ${chunk.dateTo}: `
      + `${result.counts.api_appointments_examined} examined, ${result.counts.created} created`);
  }

  return {
    mode: options.mode,
    chunks: chunks.length,
    skipped,
    ran: syncRunIds.length,
    syncRunIds,
  };
}
