/**
 * The jobs-by-stage board: every job in a tracked workflow stage, with the
 * customer, location, next scheduled visit and crew, grouped the way the
 * office's Jobs screen groups them. Read under the caller's own identity.
 */
import { dbApp, withUser, withServiceRole, type SessionContext } from "../db/client.js";
import { STAGE_GROUPS, stageGroup, stageOrder, daysInStage } from "@allied/shared/jobStages";
import { BOARD_TIMEZONE, jobProgressUrl } from "./board.js";

export interface StageInfo { code: string; name: string; color: string | null; position: number | null; jobsCount: number | null; group: string | null; count: number }

export interface JobItem {
  id: string; jobId: string; customerId: string | null; jobNumber: string | null; jobName: string | null;
  customerName: string | null; division: string | null; trades: string | null; insurance: boolean;
  stage: string | null; stageCode: string | null; stageColor: string | null; stageGroup: string | null;
  stageSince: string | null; daysInStage: number | null;
  awardedDate: string | null; contractSignedDate: string | null; totalJobPrice: number | null;
  nextVisit: { startAt: string; endAt: string; startDay: string; crews: string[]; title: string | null } | null;
  location: { address: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null } | null;
  jpUrl: string | null;
}

export interface JobsBoard {
  groups: { key: string; label: string; color: string; count: number; stages: StageInfo[] }[];
  items: JobItem[];
  sync: { startedAt: string; finishedAt: string | null; status: string } | null;
}

interface Row {
  id: string; jp_job_id: string; jp_customer_id: string | null; job_number: string | null; job_name: string | null;
  customer_name: string | null; division: string | null; trades: string | null; is_insurance: boolean;
  current_stage: string | null; stage_code: string | null; stage_color: string | null; stage_last_modified: Date | null;
  awarded_date: string | null; contract_signed_date: string | null; total_job_price: string | null;
  next_start: Date | null; next_end: Date | null; next_day: string | null; next_crews: string[] | null; next_title: string | null;
  address: string | null; city: string | null; state: string | null; zip: string | null; lat: number | null; lng: number | null;
}

export async function jobsBoard(ctx: SessionContext): Promise<JobsBoard> {
  const { stages, rows } = await withUser(dbApp(), ctx, async (c) => {
    const stages = (await c.query<{ code: string; name: string; color: string | null; position: number | null; jobs_count: number | null }>(
      `SELECT code, name, color, position, jobs_count FROM jp_workflow_stage ORDER BY position NULLS LAST, name`)).rows;
    const rows = (await c.query<Row>(
      `SELECT j.id, j.jp_job_id, j.jp_customer_id, j.job_number, j.job_name, cu.customer_name,
              j.division, j.trades, j.is_insurance, j.current_stage, j.stage_code, j.stage_color, j.stage_last_modified,
              j.awarded_date::text, j.contract_signed_date::text, j.total_job_price::text,
              nx.start_at AS next_start, nx.end_at AS next_end, (nx.start_at AT TIME ZONE $1)::date::text AS next_day,
              nx.crew_names AS next_crews, nx.title AS next_title,
              l.address, l.city, l.state, l.zip, l.lat, l.lng
         FROM jp_job j
         LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
         LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
         LEFT JOIN LATERAL (
           SELECT s.start_at, s.end_at, s.crew_names, s.title FROM jp_schedule s
            WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL AND s.end_at >= now() - interval '1 day'
            ORDER BY s.start_at LIMIT 1) nx ON true
        WHERE j.stage_seen_at IS NOT NULL
        ORDER BY j.stage_last_modified NULLS LAST, j.job_number`,
      [BOARD_TIMEZONE])).rows;
    return { stages, rows };
  });

  const items: JobItem[] = rows
    .filter((r) => stageGroup(r.current_stage) !== null)
    .map((r) => ({
      id: r.id, jobId: r.jp_job_id, customerId: r.jp_customer_id, jobNumber: r.job_number, jobName: r.job_name,
      customerName: r.customer_name, division: r.division, trades: r.trades, insurance: r.is_insurance,
      stage: r.current_stage, stageCode: r.stage_code, stageColor: r.stage_color,
      stageGroup: stageGroup(r.current_stage)?.key ?? null,
      stageSince: r.stage_last_modified ? r.stage_last_modified.toISOString() : null,
      daysInStage: daysInStage(r.stage_last_modified),
      awardedDate: r.awarded_date, contractSignedDate: r.contract_signed_date,
      totalJobPrice: r.total_job_price === null ? null : Number(r.total_job_price),
      nextVisit: r.next_start ? {
        startAt: r.next_start.toISOString(), endAt: (r.next_end ?? r.next_start).toISOString(),
        startDay: r.next_day ?? "", crews: r.next_crews ?? [], title: r.next_title,
      } : null,
      location: (r.address !== null || r.lat !== null) ? {
        address: r.address, city: r.city, state: r.state, zip: r.zip,
        lat: r.lat === null ? null : Number(r.lat), lng: r.lng === null ? null : Number(r.lng),
      } : null,
      jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
    }))
    .sort((a, b) => stageOrder(a.stage) - stageOrder(b.stage) || (b.daysInStage ?? 0) - (a.daysInStage ?? 0));

  const countByCode = new Map<string, number>();
  for (const it of items) if (it.stageCode) countByCode.set(it.stageCode, (countByCode.get(it.stageCode) ?? 0) + 1);

  const groups = STAGE_GROUPS.map((g) => {
    const gs: StageInfo[] = stages
      .filter((s) => stageGroup(s.name)?.key === g.key)
      .sort((a, b) => stageOrder(a.name) - stageOrder(b.name))
      .map((s) => ({ code: s.code, name: s.name, color: s.color, position: s.position, jobsCount: s.jobs_count,
        group: g.key, count: countByCode.get(s.code) ?? 0 }));
    return { key: g.key, label: g.label, color: g.color, count: gs.reduce((n, s) => n + s.count, 0), stages: gs };
  });

  const sync = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ started_at: Date; finished_at: Date | null; status: string }>(
      `SELECT started_at, finished_at, status FROM sync_run WHERE kind = 'job_stages' ORDER BY started_at DESC LIMIT 1`);
    const r = rows[0];
    return r ? { startedAt: r.started_at.toISOString(), finishedAt: r.finished_at ? r.finished_at.toISOString() : null, status: r.status } : null;
  }, "production:jobs-freshness", { quiet: true });

  return { groups, items, sync };
}
