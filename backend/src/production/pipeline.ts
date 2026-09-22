/**
 * Sold-Job Pipeline / Unscheduled Work.
 *
 * Every job with a signed contract, read from the JobProgress mirror with its
 * install visits and production's own notes, handed to the shared rules
 * (shared/src/soldPipeline.js) that decide what is pipeline, what is on the
 * calendar and what is not, and what the money adds up to. Read under the
 * caller's identity, so RLS decides who sees it; the notes are written the
 * same way, stamped with the writer.
 */
import { dbApp, withUser, type SessionContext } from "../db/client.js";

/** The slice of a pg client the loaders need, so a user session or the service role can drive them. */
export interface Queryable { query<R>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }> }
export type Runner = <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>;
import { isInstallCode } from "@allied/shared/production";
import { soldPipeline } from "@allied/shared/soldPipeline";
import { BOARD_TIMEZONE, jobProgressUrl, todayInBoardZone } from "./board.js";

interface Row {
  jp_job_id: string; jp_customer_id: string | null; job_number: string | null; customer_name: string | null;
  city: string | null; address: string | null; current_stage: string | null; division: string | null; trades: string | null;
  contract_signed_date: string | null; total_job_revenue: string | null; total_job_price: string | null;
  rep_names: string | null; visits: { day: string; code: string | null }[] | null;
  blocker: string | null; owner: string | null; next_action: string | null; note_updated_by: string | null; note_updated_at: Date | null;
  s_suggestion: string | null; s_confidence: string | null; s_rule_key: string | null; s_model: string | null; s_created_at: Date | null; s_accepted_at: Date | null;
}

export interface PipelineNoteInput { blocker?: string | null; owner?: string | null; nextAction?: string | null }

export async function soldPipelineReport(ctx: SessionContext, today = todayInBoardZone()) {
  return loadPipeline((fn) => withUser(dbApp(), ctx, fn), today);
}

/** The report, driven by whichever runner the caller has: a user session or the service. */
export async function loadPipeline(run: Runner, today = todayInBoardZone()) {
  const rows = await run(async (c) => {
    const { rows } = await c.query<Row>(
      `SELECT j.jp_job_id, j.jp_customer_id, j.job_number, cu.customer_name, l.city, l.address,
              j.current_stage, j.division, j.trades, j.contract_signed_date::text,
              j.total_job_revenue::text, j.total_job_price::text, j.rep_names,
              sch.visits, n.blocker, n.owner, n.next_action, n.updated_by AS note_updated_by, n.updated_at AS note_updated_at,
              s.suggestion AS s_suggestion, s.confidence AS s_confidence, s.rule_key AS s_rule_key, s.model AS s_model,
              s.created_at AS s_created_at, s.accepted_at AS s_accepted_at
         FROM jp_job j
         LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
         LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
         LEFT JOIN job_pipeline_note n ON n.jp_job_id = j.jp_job_id
         LEFT JOIN job_next_action_suggestion s ON s.jp_job_id = j.jp_job_id
         LEFT JOIN LATERAL (
           SELECT json_agg(json_build_object('day', (s.start_at AT TIME ZONE $1)::date::text, 'code', s.job_type_code) ORDER BY s.start_at) AS visits
             FROM jp_schedule s WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL) sch ON true
        WHERE j.contract_signed_date IS NOT NULL AND NOT j.is_insurance`,
      [BOARD_TIMEZONE]);
    return rows;
  });

  const jobs = rows.map((r) => ({
    jobId: r.jp_job_id, customerId: r.jp_customer_id, jobNumber: r.job_number, customer: r.customer_name,
    city: r.city, address: r.address, stage: r.current_stage, division: r.division, trades: r.trades,
    contractSignedDate: r.contract_signed_date,
    contract: r.total_job_revenue ?? r.total_job_price,
    // Install visits only (RR, SR, GUTTERS…): a site assessment is not a production date.
    installDays: [...new Set((r.visits ?? []).filter((v) => isInstallCode(v.code)).map((v) => v.day))].sort(),
    rep: r.rep_names,
    note: r.note_updated_by ? {
      blocker: r.blocker, owner: r.owner, nextAction: r.next_action,
      updatedBy: r.note_updated_by, updatedAt: r.note_updated_at ? r.note_updated_at.toISOString() : null,
    } : null,
    jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
    // The standing suggestion, shown only while nobody has written a Next Action.
    suggested: r.s_suggestion ? {
      text: r.s_suggestion, confidence: r.s_confidence, ruleKey: r.s_rule_key, model: r.s_model,
      at: r.s_created_at ? r.s_created_at.toISOString() : null, accepted: !!r.s_accepted_at,
    } : null,
  }));
  return soldPipeline(jobs, today);
}

const clean = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 500) : null;
};

/** Production's Blocker / Owner / Next Action for one job — an upsert, stamped with the writer. */
export async function savePipelineNote(ctx: SessionContext, jobId: string, input: PipelineNoteInput) {
  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query<{ blocker: string | null; owner: string | null; next_action: string | null; updated_by: string; updated_at: Date }>(
      `INSERT INTO job_pipeline_note (jp_job_id, blocker, owner, next_action, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (jp_job_id) DO UPDATE
         SET blocker = EXCLUDED.blocker, owner = EXCLUDED.owner, next_action = EXCLUDED.next_action,
             updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING blocker, owner, next_action, updated_by, updated_at`,
      [jobId, clean(input.blocker), clean(input.owner), clean(input.nextAction), ctx.email]);
    const n = rows[0]!;
    return { jobId, blocker: n.blocker, owner: n.owner, nextAction: n.next_action, updatedBy: n.updated_by, updatedAt: n.updated_at.toISOString() };
  });
}
