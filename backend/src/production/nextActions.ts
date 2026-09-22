/**
 * Next Action suggestions — the run, the accept, the instructions, the status.
 *
 * The run walks the Sold-Job Pipeline as the service (it has no user), skips
 * every job a person has already written a next action for, settles the
 * scheduled and in-production jobs with the stage rule alone, and asks the
 * model only about the unscheduled and awaiting-payment ones whose facts
 * changed since last time. Three calls in flight at once; a failure or a
 * refusal leaves the rule standing in. Everything is logged to sync_run as
 * 'next_actions' with token counts and an estimated cost.
 */
import { dbApp, withUser, withServiceRole, type SessionContext } from "../db/client.js";
import { loadPipeline, type Queryable } from "./pipeline.js";
import { todayInBoardZone } from "./board.js";
import { suggestNextAction, DEFAULT_NEXT_ACTION_MODEL, type NextActionModelOptions } from "../integrations/anthropic/nextAction.js";
import { ruleFor, needsModel, suggestionFacts, factsHash, DEFAULT_INSTRUCTIONS } from "@allied/shared/nextAction";

export const INSTRUCTION_KEY = "pipeline_next_action";

/** List price per million tokens, for the run's estimated cost. Unknown model → null. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5], "claude-sonnet-5": [2, 10], "claude-sonnet-4-6": [3, 15], "claude-opus-5": [5, 25], "claude-opus-4-8": [5, 25],
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  if (!p) return null;
  return Math.round(((inputTokens * p[0] + outputTokens * p[1]) / 1_000_000) * 10_000) / 10_000;
}

export interface NextActionCounts {
  rows: number; humanOwned: number; unchanged: number; ruleOnly: number; suggested: number; failed: number; refused: number;
  inputTokens: number; outputTokens: number; estimatedCostUsd: number | null;
}
export interface NextActionRunResult { syncRunId: string; status: "completed" | "failed"; model: string; counts: NextActionCounts; errorMessage?: string }

export function nextActionSettings(env = process.env) {
  const model = env.NEXT_ACTION_MODEL || DEFAULT_NEXT_ACTION_MODEL;
  const enabled = !!env.ANTHROPIC_API_KEY && env.NEXT_ACTION_ENABLED !== "false";
  const reason = !env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY not set" : env.NEXT_ACTION_ENABLED === "false" ? "NEXT_ACTION_ENABLED is false" : "";
  return { model, enabled, reason };
}

const service = <T>(fn: (c: Queryable) => Promise<T>, label: string) => withServiceRole(fn, label, { quiet: true });

/** The managers' instructions, or the starter text until they write their own. */
export async function getInstructions(run: <T>(fn: (c: Queryable) => Promise<T>) => Promise<T>) {
  const { rows } = await run((c) => c.query<{ body: string; updated_by: string; updated_at: Date }>(
    `SELECT body, updated_by, updated_at FROM ai_instruction WHERE key = $1`, [INSTRUCTION_KEY]));
  const r = rows[0];
  return r
    ? { body: r.body, isDefault: false, updatedBy: r.updated_by, updatedAt: r.updated_at.toISOString() }
    : { body: DEFAULT_INSTRUCTIONS, isDefault: true, updatedBy: null, updatedAt: null };
}

export async function saveInstructions(ctx: SessionContext, body: string) {
  const text = String(body ?? "").trim();
  if (text.length < 40) throw Object.assign(new Error("Instructions are too short to be useful (40 characters minimum)."), { statusCode: 400 });
  if (text.length > 8000) throw Object.assign(new Error("Instructions are too long (8,000 characters maximum)."), { statusCode: 400 });
  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query<{ updated_at: Date }>(
      `INSERT INTO ai_instruction (key, body, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING updated_at`, [INSTRUCTION_KEY, text, ctx.email]);
    return { body: text, isDefault: false, updatedBy: ctx.email, updatedAt: rows[0]!.updated_at.toISOString() };
  });
}

interface Existing { jp_job_id: string; facts_hash: string }

/** Run at most `limit` promises at a time, in order of submission. */
async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const item = items[i++]!; await work(item); }
  });
  await Promise.all(workers);
}

export async function runNextActions(
  options: { startedBy?: string; force?: boolean; now?: Date; model?: NextActionModelOptions; env?: NodeJS.ProcessEnv } = {},
): Promise<NextActionRunResult> {
  const env = options.env ?? process.env;
  const settings = nextActionSettings(env);
  const model = options.model?.model ?? settings.model;
  const counts: NextActionCounts = { rows: 0, humanOwned: 0, unchanged: 0, ruleOnly: 0, suggested: 0, failed: 0, refused: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const today = todayInBoardZone(options.now);
  const syncRunId = await openRun(options.startedBy, today);
  try {
    if (!settings.enabled && !options.model?.apiKey) throw new Error(settings.reason);
    const report = await loadPipeline((fn) => service(fn, "next-actions:pipeline"), today);
    const { body: instructions } = await getInstructions((fn) => service(fn, "next-actions:instructions"));
    const instructionsHash = factsHash({ instructions, model });
    const existing = new Map((await service((c) => c.query<Existing>(`SELECT jp_job_id, facts_hash FROM job_next_action_suggestion`), "next-actions:existing")).rows.map((r) => [r.jp_job_id, r.facts_hash]));

    // The shared report is JavaScript; name the fields the run reads.
    interface Row { jobId: string; bucket: string; nextAction: string | null; [k: string]: unknown }
    const rows = report.rows as unknown as Row[];
    counts.rows = rows.length;
    const todo: { row: Row; hash: string; rule: ReturnType<typeof ruleFor>; facts: Record<string, unknown> }[] = [];
    for (const row of rows) {
      if (row.nextAction) { counts.humanOwned++; continue; }   // a person has spoken; nothing to suggest
      const rule = ruleFor(row);
      const facts = suggestionFacts(row, rule) as Record<string, unknown>;
      const hash = factsHash(facts, instructionsHash);
      if (!options.force && existing.get(row.jobId) === hash) { counts.unchanged++; continue; }
      todo.push({ row, hash, rule, facts });
    }

    const upsert = (jobId: string, hash: string, ruleKey: string | null, suggestion: string | null, confidence: string | null, usedModel: string, inTok: number, outTok: number, error: string | null) =>
      service((c) => c.query(
        `INSERT INTO job_next_action_suggestion (jp_job_id, facts_hash, rule_key, suggestion, confidence, model, input_tokens, output_tokens, error, created_at, accepted_at, accepted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL, NULL)
         ON CONFLICT (jp_job_id) DO UPDATE SET facts_hash = EXCLUDED.facts_hash, rule_key = EXCLUDED.rule_key, suggestion = EXCLUDED.suggestion,
           confidence = EXCLUDED.confidence, model = EXCLUDED.model, input_tokens = EXCLUDED.input_tokens, output_tokens = EXCLUDED.output_tokens,
           error = EXCLUDED.error, created_at = now(), accepted_at = NULL, accepted_by = NULL`,
        [jobId, hash, ruleKey, suggestion, confidence, usedModel, inTok, outTok, error]), "next-actions:upsert");

    // Rule-only jobs first: free and instant.
    const modelJobs: typeof todo = [];
    for (const t of todo) {
      if (needsModel(t.row)) { modelJobs.push(t); continue; }
      await upsert(t.row.jobId, t.hash, t.rule?.key ?? null, t.rule?.action ?? null, t.rule ? "high" : null, "rule", 0, 0, null);
      counts.ruleOnly++;
    }
    // Then the model, three at a time.
    await pool(modelJobs, 3, async (t) => {
      const r = await suggestNextAction({ instructions, facts: t.facts }, { ...options.model, model, apiKey: options.model?.apiKey ?? env.ANTHROPIC_API_KEY });
      counts.inputTokens += r.inputTokens; counts.outputTokens += r.outputTokens;
      if (r.suggestion) {
        await upsert(t.row.jobId, t.hash, t.rule?.key ?? null, r.suggestion, r.confidence, r.model, r.inputTokens, r.outputTokens, null);
        counts.suggested++;
      } else {
        if (r.error === "refused") counts.refused++; else counts.failed++;
        await upsert(t.row.jobId, t.hash, t.rule?.key ?? null, t.rule?.action ?? null, t.rule ? "medium" : null, "rule-fallback", r.inputTokens, r.outputTokens, r.error);
      }
    });
    counts.estimatedCostUsd = estimateCostUsd(model, counts.inputTokens, counts.outputTokens);
    await closeRun(syncRunId, "completed", counts);
    return { syncRunId, status: "completed", model, counts };
  } catch (err) {
    const message = (err as Error).message;
    await closeRun(syncRunId, "failed", counts, message);
    return { syncRunId, status: "failed", model, counts, errorMessage: message };
  }
}

/** Copy the suggestion into the job's note as its Next Action, and record who took it. */
export async function acceptSuggestion(ctx: SessionContext, jobId: string) {
  return withUser(dbApp(), ctx, async (c) => {
    const { rows } = await c.query<{ suggestion: string | null }>(`SELECT suggestion FROM job_next_action_suggestion WHERE jp_job_id = $1`, [jobId]);
    const suggestion = rows[0]?.suggestion ?? null;
    if (!suggestion) throw Object.assign(new Error("There is no suggestion for this job."), { statusCode: 404 });
    await c.query(
      `INSERT INTO job_pipeline_note (jp_job_id, next_action, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (jp_job_id) DO UPDATE SET next_action = EXCLUDED.next_action, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [jobId, suggestion, ctx.email]);
    await c.query(`UPDATE job_next_action_suggestion SET accepted_at = now(), accepted_by = $2 WHERE jp_job_id = $1`, [jobId, ctx.email]);
    return { jobId, nextAction: suggestion, acceptedBy: ctx.email };
  });
}

export async function nextActionStatus(env = process.env) {
  const s = nextActionSettings(env);
  const last = await service(async (c) => {
    const { rows } = await c.query<{ id: string; started_at: Date; finished_at: Date | null; status: string; counts: NextActionCounts | null; error_message: string | null; started_by: string | null }>(
      `SELECT id, started_at, finished_at, status, counts, error_message, started_by FROM sync_run WHERE kind = 'next_actions' ORDER BY started_at DESC LIMIT 1`);
    const r = rows[0];
    return r ? { id: r.id, startedAt: r.started_at.toISOString(), finishedAt: r.finished_at ? r.finished_at.toISOString() : null, status: r.status, counts: r.counts, errorMessage: r.error_message, startedBy: r.started_by } : null;
  }, "next-actions:status");
  return { enabled: s.enabled, reason: s.reason, model: s.model, cron: env.NEXT_ACTION_CRON || "15 10 * * *", lastRun: last };
}

async function openRun(startedBy: string | undefined, today: string): Promise<string> {
  return service(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('next_actions', 'commit', 'running', $1::date, $1::date, false, $2) RETURNING id`, [today, startedBy ?? null]);
    return rows[0]!.id;
  }, "next-actions:open-run");
}
async function closeRun(id: string, status: "completed" | "failed", counts: NextActionCounts, errorMessage?: string): Promise<void> {
  await service((c) => c.query(
    `UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4 WHERE id = $1`,
    [id, status, JSON.stringify(counts), errorMessage ?? null]), "next-actions:close-run");
}
