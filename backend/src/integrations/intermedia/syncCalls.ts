/**
 * The Unite call sync: users and outside calls into the mirror, matched to
 * leads by phone number. Phase 1 of the call-recordings project.
 *
 * Each run:
 *   1. Users — every extension on the account, upserted (their names are how
 *      a call is attributed to a rep; their ids are what recordings key on).
 *   2. Calls — one record per call that STARTED in the look-back window
 *      (default 48 h, so a delayed record or a missed run is picked up by the
 *      next one). Internal extension-to-extension calls are dropped: no
 *      customer on either end. The rest are upserted on the vendor's call id.
 *   3. Matching — every stored call with no lead yet is matched against
 *      jp_customer_phone on its outside number. Re-tried on every run, so a
 *      lead whose number reaches JobProgress after the call still gets it.
 *      When two customers share a number, the newest lead wins.
 *
 * Nothing here touches recordings or transcripts; that is Phase 2.
 */
import { withServiceRole } from "../../db/client.js";
import { UniteClient, type UniteCallDetail, type UniteContact } from "./client.js";
import { phoneKey, phoneKeys } from "@allied/shared/phone";

export const DEFAULT_LOOKBACK_HOURS = 48;

export interface UniteSyncCounts {
  users_examined: number; users_upserted: number;
  calls_examined: number; calls_upserted: number; calls_internal_skipped: number; calls_without_number: number;
  calls_matched_now: number; calls_unmatched_total: number;
  errors: number;
}
export interface UniteSyncResult { syncRunId: string; status: "completed" | "failed"; counts: UniteSyncCounts; from: string; to: string; errorMessage?: string }

const emptyCounts = (): UniteSyncCounts => ({
  users_examined: 0, users_upserted: 0, calls_examined: 0, calls_upserted: 0, calls_internal_skipped: 0, calls_without_number: 0,
  calls_matched_now: 0, calls_unmatched_total: 0, errors: 0,
});

const str = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === "" ? null : String(v).trim());

/** A unite_user row from an Address Book contact. */
export function mapUser(c: UniteContact): Record<string, unknown> {
  return {
    unite_user_id: c.id, display_name: str(c.displayName), email: str(c.email), extension: str(c.pbx?.extension), type: str(c.type),
    numbers: phoneKeys((c.phoneNumbers ?? []).flatMap((p) => [p.internationalFormatNumber, p.number])),
    raw: JSON.stringify(c),
  };
}

/**
 * A unite_call row from a call record, or null for an internal call. The
 * outside party is the caller on an inbound call and the callee on an
 * outbound one; our side is whichever participant carries a user id.
 */
export function mapCall(x: UniteCallDetail): Record<string, unknown> | null {
  if (x.direction !== "inbound" && x.direction !== "outbound") return null;
  const outside = x.direction === "inbound" ? x.from : x.to;
  const ours = x.direction === "inbound" ? x.to : x.from;
  const started = new Date(x.start);
  if (Number.isNaN(started.getTime())) return null;
  return {
    unite_call_id: x.id, global_call_id: str(x.globalCallId), started_at: started, duration_seconds: Number(x.duration) || 0,
    direction: x.direction,
    from_number: str(x.from?.number), from_name: str(x.from?.name), from_user_id: str(x.from?.userUniqueId),
    to_number: str(x.to?.number), to_name: str(x.to?.name), to_user_id: str(x.to?.userUniqueId),
    group_name: str(x.group),
    external_key: phoneKey(outside?.number ?? ""),
    rep_user_id: str(ours?.userUniqueId) ?? str(outside?.userUniqueId),
    raw: JSON.stringify(x),
  };
}

const UPSERT_USER = `
  INSERT INTO unite_user (unite_user_id, display_name, email, extension, type, numbers, raw, last_seen_at)
  VALUES ($1,$2,$3,$4,$5,$6::text[],$7::jsonb,now())
  ON CONFLICT (unite_user_id) DO UPDATE SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, extension = EXCLUDED.extension,
    type = EXCLUDED.type, numbers = EXCLUDED.numbers, raw = EXCLUDED.raw, last_seen_at = now()`;

const UPSERT_CALL = `
  INSERT INTO unite_call (unite_call_id, global_call_id, started_at, duration_seconds, direction, from_number, from_name, from_user_id,
                          to_number, to_name, to_user_id, group_name, external_key, rep_user_id, raw, last_seen_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,now())
  ON CONFLICT (unite_call_id) DO UPDATE SET global_call_id = EXCLUDED.global_call_id, started_at = EXCLUDED.started_at,
    duration_seconds = EXCLUDED.duration_seconds, direction = EXCLUDED.direction, from_number = EXCLUDED.from_number, from_name = EXCLUDED.from_name,
    from_user_id = EXCLUDED.from_user_id, to_number = EXCLUDED.to_number, to_name = EXCLUDED.to_name, to_user_id = EXCLUDED.to_user_id,
    group_name = EXCLUDED.group_name, external_key = EXCLUDED.external_key, rep_user_id = EXCLUDED.rep_user_id, raw = EXCLUDED.raw, last_seen_at = now()`;

/** Matches every unmatched call to a lead by number; newest lead wins a shared number. Returns how many were matched now. */
export async function matchCallsToLeads(): Promise<number> {
  return withServiceRole(async (c) => {
    const { rowCount } = await c.query(
      `UPDATE unite_call uc
          SET jp_customer_id = m.jp_customer_id, matched_at = now()
         FROM (SELECT DISTINCT ON (p.phone_key) p.phone_key, p.jp_customer_id
                 FROM jp_customer_phone p JOIN jp_customer cu ON cu.jp_customer_id = p.jp_customer_id
                ORDER BY p.phone_key, cu.jp_created_at DESC NULLS LAST) m
        WHERE uc.jp_customer_id IS NULL AND uc.external_key = m.phone_key`);
    return rowCount ?? 0;
  }, "unite:match", { quiet: true });
}

async function openRun(startedBy: string | undefined, from: Date, to: Date): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('unite_calls','commit','running', $2::date, $3::date, false, $1) RETURNING id`,
      [startedBy ?? null, from, to]);
    return rows[0]!.id;
  }, "unite:open-run", { quiet: true });
}
async function closeRun(id: string, status: "completed" | "failed", counts: UniteSyncCounts, errorMessage?: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(`UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4 WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "unite:close-run", { quiet: true });
}

export async function runUniteCallSync(options: {
  client?: UniteClient | null; startedBy?: string; now?: Date; lookbackHours?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<UniteSyncResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const hours = options.lookbackHours ?? (Number(env.UNITE_SYNC_LOOKBACK_HOURS) || DEFAULT_LOOKBACK_HOURS);
  const from = new Date(now.getTime() - hours * 3_600_000);
  const counts = emptyCounts();
  const syncRunId = await openRun(options.startedBy, from, now);
  try {
    const client = options.client === undefined ? UniteClient.fromEnv(env) : options.client;
    if (!client) throw new Error("Intermedia Unite is not configured (INTERMEDIA_CLIENT_ID / INTERMEDIA_CLIENT_SECRET)");

    const contacts = await client.listAccountContacts();
    counts.users_examined = contacts.length;
    const users = contacts.filter((u) => u.pbx?.extension).map(mapUser);
    await withServiceRole(async (c) => {
      for (const u of users) {
        await c.query(UPSERT_USER, [u["unite_user_id"], u["display_name"], u["email"], u["extension"], u["type"], u["numbers"], u["raw"]]);
        counts.users_upserted++;
      }
    }, "unite:users", { quiet: true });

    const { calls } = await client.listCallDetails(from, now);
    counts.calls_examined = calls.length;
    const rows: Record<string, unknown>[] = [];
    for (const x of calls) {
      const r = mapCall(x);
      if (!r) { counts.calls_internal_skipped++; continue; }
      if (!r["external_key"]) counts.calls_without_number++;
      rows.push(r);
    }
    await withServiceRole(async (c) => {
      for (const r of rows) {
        await c.query(UPSERT_CALL, [
          r["unite_call_id"], r["global_call_id"], r["started_at"], r["duration_seconds"], r["direction"], r["from_number"], r["from_name"], r["from_user_id"],
          r["to_number"], r["to_name"], r["to_user_id"], r["group_name"], r["external_key"], r["rep_user_id"], r["raw"]]);
        counts.calls_upserted++;
      }
    }, "unite:calls", { quiet: true });

    counts.calls_matched_now = await matchCallsToLeads();
    counts.calls_unmatched_total = await withServiceRole(async (c) => Number(
      (await c.query<{ n: string }>(`SELECT count(*) AS n FROM unite_call WHERE jp_customer_id IS NULL AND external_key IS NOT NULL`)).rows[0]!.n),
      "unite:unmatched", { quiet: true });

    await closeRun(syncRunId, "completed", counts);
    return { syncRunId, status: "completed", counts, from: from.toISOString(), to: now.toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    counts.errors++;
    await closeRun(syncRunId, "failed", counts, message);
    return { syncRunId, status: "failed", counts, from: from.toISOString(), to: now.toISOString(), errorMessage: message };
  }
}

export interface UniteMirrorStatus {
  users: number; calls: number; matched: number; customersWithCalls: number; oldest: string | null; newest: string | null;
  lastRun: { started_at: string; finished_at: string | null; status: string; counts: Record<string, unknown> | null; error_message: string | null } | null;
}

/** What the mirror holds, for the admin page. */
export async function uniteMirrorStatus(): Promise<UniteMirrorStatus> {
  return withServiceRole(async (c) => {
    const t = (await c.query<{ users: string; calls: string; matched: string; customers: string; oldest: Date | null; newest: Date | null }>(
      `SELECT (SELECT count(*) FROM unite_user) AS users,
              (SELECT count(*) FROM unite_call) AS calls,
              (SELECT count(*) FROM unite_call WHERE jp_customer_id IS NOT NULL) AS matched,
              (SELECT count(DISTINCT jp_customer_id) FROM unite_call WHERE jp_customer_id IS NOT NULL) AS customers,
              (SELECT min(started_at) FROM unite_call) AS oldest,
              (SELECT max(started_at) FROM unite_call) AS newest`)).rows[0]!;
    const run = (await c.query<UniteMirrorStatus["lastRun"] & object>(
      `SELECT started_at::text, finished_at::text, status, counts, error_message FROM sync_run WHERE kind = 'unite_calls' ORDER BY started_at DESC LIMIT 1`)).rows[0] ?? null;
    return {
      users: Number(t.users), calls: Number(t.calls), matched: Number(t.matched), customersWithCalls: Number(t.customers),
      oldest: t.oldest ? t.oldest.toISOString() : null, newest: t.newest ? t.newest.toISOString() : null, lastRun: run,
    };
  }, "unite:status", { quiet: true });
}
