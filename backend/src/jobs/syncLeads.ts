/**
 * The lead sweep: every job created since the start of the reporting year,
 * whatever stage it sits in, into the jp_job mirror.
 *
 * The production stage sweep (production/syncJobStages.ts) only sees jobs in
 * Project Won / Production / Warranty stages — the ~20 lead-pipeline stages
 * were invisible, so the Overview could not say why a lead never got an
 * appointment. This fills that in. It rides along with the customer sync
 * (four times a day): leads and customers are the same world and the same
 * cadence.
 *
 * Two things it must never do:
 *  - Touch `stage_seen_at`. That column is the production board's "in a
 *    tracked stage" mark; the board, the Weekly Job Sheet and the money
 *    refreshes all key off it. A row from here carries no such key, so the
 *    upsert (which overwrites every key present) leaves it alone.
 *  - Trigger paid reads. No financials, payments or bills — just the job.
 *
 * Re-sweeping from the start of the year every run is deliberate: a June lead
 * that gets DQ'd in September changes stage, and the only way to catch that
 * without a "stage changed since" watermark is to look again. It is ~20 pages.
 */
import type { JobProgressClient } from "../integrations/jobprogress/client.js";
import { mapStageJob } from "../production/syncJobStages.js";
import { upsertJpRows } from "./syncJobProgress.js";

export interface LeadSweepCounts { leads_examined: number; leads_upserted: number }

/** Jan 1 of the current year unless LEAD_SWEEP_FROM says otherwise. */
export function leadSweepFrom(env: NodeJS.ProcessEnv = process.env, now = new Date()): string {
  const v = (env["LEAD_SWEEP_FROM"] ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : `${now.getFullYear()}-01-01`;
}

export async function sweepLeadJobs(client: JobProgressClient, counts: LeadSweepCounts, now = new Date()): Promise<void> {
  const from = leadSweepFrom(process.env, now);
  const to = now.toISOString().slice(0, 10);
  const jobs = await client.listJobsCreatedBetween(from, to);
  counts.leads_examined = jobs.length;
  // Division names ride on the include, so no divisions lookup is needed here.
  const rows = jobs.map((j) => {
    const row = mapStageJob(j, new Map(), false);
    delete row["stage_seen_at"]; // see the header: never ours to set or clear
    return row;
  }).filter((r) => r["jp_job_id"]);
  counts.leads_upserted = await upsertJpRows("jp_job", "jp_job_id", rows);
}
