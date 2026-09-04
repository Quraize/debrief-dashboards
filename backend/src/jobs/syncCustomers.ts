/**
 * Customer (lead) and referral-source sync: JobProgress → jp_customer,
 * jp_referral, and the debrief form's Marketing Source dropdown.
 *
 * The lead source lives on the CRM customer, set at intake. Mirroring every
 * customer gives the marketing dashboard the top of the funnel — leads by
 * source and month, including the ones that never became an appointment —
 * and lets appointments and jobs be attributed by source through their
 * customer id.
 *
 * Referral names are also pushed into list_option (category marketing_source)
 * when missing, so a rep can never pick a source the CRM doesn't have, and the
 * CRM can never have one the debrief form lacks.
 */
import { withServiceRole } from "../db/client.js";
import { JobProgressClient, unwrap } from "../integrations/jobprogress/client.js";
import { parseApiTimestamp } from "../production/syncSchedules.js";

export interface CustomerSyncCounts {
  referrals_examined: number;
  referrals_upserted: number;
  marketing_sources_added: number;
  customers_examined: number;
  customers_created: number;
  customers_updated: number;
  customers_without_source: number;
  customers_skipped: number;
  api_requests: number;
  retries: number;
  rate_limit_hits: number;
  errors: number;
}

export interface CustomerSyncOptions {
  startedBy?: string;
  client?: JobProgressClient;
}

export interface CustomerSyncResult {
  syncRunId: string;
  status: "completed" | "failed";
  counts: CustomerSyncCounts;
  errorMessage?: string;
}

export interface CustomerRow {
  jp_customer_id: string;
  customer_name: string | null;
  company_name: string | null;
  is_commercial: boolean;
  referred_by_type: string | null;
  referred_by_id: string | null;
  referred_by_name: string | null;
  referred_by_note: string | null;
  referred_by_customer_id: string | null;
  call_center_rep: string | null;
  canvasser: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  jp_created_at: Date | null;
  jp_updated_at: Date | null;
  raw: Record<string, unknown>;
}

const emptyCounts = (): CustomerSyncCounts => ({
  referrals_examined: 0, referrals_upserted: 0, marketing_sources_added: 0,
  customers_examined: 0, customers_created: 0, customers_updated: 0,
  customers_without_source: 0, customers_skipped: 0,
  api_requests: 0, retries: 0, rate_limit_hits: 0, errors: 0,
});

const str = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const bool = (v: unknown): boolean => v === true || v === 1 || v === "1" || v === "true";

/** A person-ish value: the API sometimes sends "" and sometimes an object. */
function personName(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "string") return str(v);
  const p = unwrap(v);
  if (!p) return null;
  return str([p["first_name"], p["last_name"]].map((x) => str(x) ?? "").join(" ")) ?? str(p["name"]) ?? str(p["email"]);
}

export function mapCustomer(api: Record<string, unknown>): CustomerRow | null {
  const id = str(api["id"]);
  if (!id) return null;
  const referredBy = unwrap(api["referred_by"]);
  const address = unwrap(api["address"]);
  const stateObj = address ? unwrap(address["state"]) : null;
  const name = str([api["first_name"], api["last_name"]].map((x) => str(x) ?? "").join(" "));
  return {
    jp_customer_id: id,
    customer_name: name ?? str(api["company_name"]),
    company_name: str(api["company_name"]),
    is_commercial: bool(api["is_commercial"]),
    referred_by_type: str(api["referred_by_type"]),
    referred_by_id: str(api["referred_by_id"]),
    referred_by_name: referredBy ? str(referredBy["name"]) : null,
    referred_by_note: str(api["referred_by_note"]),
    referred_by_customer_id: str(api["referred_by_customer_id"]),
    call_center_rep: personName(api["call_center_rep"]),
    canvasser: personName(api["canvasser"]),
    city: address ? str(address["city"]) : null,
    state: stateObj ? str(stateObj["code"]) : address ? str(address["state"]) : null,
    zip: address ? str(address["zip"]) : null,
    jp_created_at: parseApiTimestamp(api["created_at"]),
    jp_updated_at: parseApiTimestamp(api["updated_at"]),
    raw: api,
  };
}

/** True when the CRM recorded no usable source for the lead. */
export const hasNoSource = (r: CustomerRow): boolean =>
  !r.referred_by_name && r.referred_by_type !== "customer" && !r.referred_by_note;

async function openRun(startedBy: string | undefined): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('customers','commit','running', current_date, current_date, false, $1) RETURNING id`,
      [startedBy ?? null]);
    return rows[0]!.id;
  }, "customers:open-run", { quiet: true });
}

async function closeRun(
  id: string, status: "completed" | "failed", counts: CustomerSyncCounts, errorMessage?: string,
): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(
      `UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4 WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "customers:close-run", { quiet: true });
}

async function upsertReferrals(items: Record<string, unknown>[], counts: CustomerSyncCounts): Promise<void> {
  counts.referrals_examined = items.length;
  if (items.length === 0) return;
  await withServiceRole(async (c) => {
    for (const it of items) {
      const id = str(it["id"]);
      const name = str(it["name"]);
      if (!id || !name) continue;
      await c.query(
        `INSERT INTO jp_referral (jp_referral_id, name, jp_created_at, jp_updated_at, last_seen_at)
         VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (jp_referral_id) DO UPDATE SET
           name = EXCLUDED.name, jp_created_at = EXCLUDED.jp_created_at,
           jp_updated_at = EXCLUDED.jp_updated_at, last_seen_at = now()`,
        [id, name, parseApiTimestamp(it["created_at"]), parseApiTimestamp(it["updated_at"])]);
      counts.referrals_upserted++;

      // Keep the debrief dropdown in step with the CRM. Case- and
      // whitespace-insensitive so "Bing Paid - WR " does not duplicate an
      // existing "Bing Paid - WR".
      const { rowCount } = await c.query(
        `INSERT INTO list_option (category, value, active, created_by)
         SELECT 'marketing_source', $1, true, 'jobprogress-sync'
          WHERE NOT EXISTS (
            SELECT 1 FROM list_option
             WHERE category = 'marketing_source' AND lower(trim(value)) = lower(trim($1)))`,
        [name]);
      if (rowCount) counts.marketing_sources_added++;
    }
  }, "customers:referrals");
}

const UPSERT_CUSTOMER = `
  INSERT INTO jp_customer (
    jp_customer_id, customer_name, company_name, is_commercial, referred_by_type, referred_by_id,
    referred_by_name, referred_by_note, referred_by_customer_id, call_center_rep, canvasser,
    city, state, zip, jp_created_at, jp_updated_at, raw, last_seen_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,now())
  ON CONFLICT (jp_customer_id) DO UPDATE SET
    customer_name = EXCLUDED.customer_name, company_name = EXCLUDED.company_name,
    is_commercial = EXCLUDED.is_commercial, referred_by_type = EXCLUDED.referred_by_type,
    referred_by_id = EXCLUDED.referred_by_id, referred_by_name = EXCLUDED.referred_by_name,
    referred_by_note = EXCLUDED.referred_by_note, referred_by_customer_id = EXCLUDED.referred_by_customer_id,
    call_center_rep = EXCLUDED.call_center_rep, canvasser = EXCLUDED.canvasser,
    city = EXCLUDED.city, state = EXCLUDED.state, zip = EXCLUDED.zip,
    jp_created_at = EXCLUDED.jp_created_at, jp_updated_at = EXCLUDED.jp_updated_at,
    raw = EXCLUDED.raw, last_seen_at = now()
  RETURNING (xmax = 0) AS inserted`;

async function upsertCustomers(rows: CustomerRow[], counts: CustomerSyncCounts): Promise<void> {
  const BATCH = 250;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await withServiceRole(async (c) => {
      for (const r of slice) {
        const { rows: out } = await c.query<{ inserted: boolean }>(UPSERT_CUSTOMER, [
          r.jp_customer_id, r.customer_name, r.company_name, r.is_commercial, r.referred_by_type, r.referred_by_id,
          r.referred_by_name, r.referred_by_note, r.referred_by_customer_id, r.call_center_rep, r.canvasser,
          r.city, r.state, r.zip, r.jp_created_at, r.jp_updated_at, JSON.stringify(r.raw),
        ]);
        if (out[0]?.inserted) counts.customers_created++;
        else counts.customers_updated++;
        if (hasNoSource(r)) counts.customers_without_source++;
      }
    }, "customers:upsert", { quiet: true });
  }
}

export async function runCustomerSync(options: CustomerSyncOptions = {}): Promise<CustomerSyncResult> {
  const counts = emptyCounts();
  const client = options.client ?? new JobProgressClient({
    onStat: (kind) => {
      if (kind === "request") counts.api_requests++;
      else if (kind === "retry") counts.retries++;
      else if (kind === "rateLimitHit") counts.rate_limit_hits++;
      else if (kind === "error") counts.errors++;
    },
  });

  const syncRunId = await openRun(options.startedBy);
  try {
    await upsertReferrals(await client.listReferrals(), counts);

    const api = await client.listCustomers();
    counts.customers_examined = api.length;
    const rows: CustomerRow[] = [];
    for (const item of api) {
      const row = mapCustomer(item);
      if (row) rows.push(row);
      else counts.customers_skipped++;
    }
    await upsertCustomers(rows, counts);

    await closeRun(syncRunId, "completed", counts);
    return { syncRunId, status: "completed", counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    counts.errors++;
    await closeRun(syncRunId, "failed", counts, message);
    return { syncRunId, status: "failed", counts, errorMessage: message };
  }
}
