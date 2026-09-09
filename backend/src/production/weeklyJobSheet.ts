/**
 * The Weekly Job Sheet feed: every job in a tracked production stage, shaped
 * as one row of the production master sheet's WEEKLY JOB SHEET tab (column map
 * in shared/src/weeklyJobSheet.js). Read under the caller's own identity.
 *
 * Sources, column by column:
 *   A  job number            jp_job.job_number            (jobs listing)
 *   K  division              jp_job.division
 *   L  trades                jp_job.trades
 *   M  stage                 jp_job.current_stage
 *   N  sales rep             jp_job.rep_names             (`reps` include)
 *   O  sub                   jp_job.sub_contractor_names  (`sub_contractors` include),
 *                            else the crews on the job's production schedules
 *   P  scheduled install     first production schedule for the job (jp_schedule)
 *   Q  sale date             jp_job.contract_signed_date
 *   R  gross                 jp_job.total_job_price       (financial summary)
 *   S  change orders         jp_job.total_change_order_amount
 *   T  total revenue         jp_job.total_job_revenue, else R + S
 *   AA total payments        jp_job.total_payment_received
 *   AB balance owed          jp_job.total_amount_owed, else T − AA
 */
import { dbApp, withUser, withServiceRole, type SessionContext } from "../db/client.js";
import { stageGroup } from "@allied/shared/jobStages";
import { totalRevenue, balanceOwed, rowLabel } from "@allied/shared/weeklyJobSheet";
import { BOARD_TIMEZONE, jobProgressUrl } from "./board.js";

export interface SheetRow {
  jobId: string; customerId: string | null; jobNumber: string | null; jobName: string | null;
  customer: string | null; address: string | null; city: string | null; label: string;
  division: string | null; trades: string | null; insurance: boolean;
  stage: string | null; stageGroup: string | null; stageSince: string | null;
  salesRep: string | null; sub: string | null;
  scheduledInstallDate: string | null; saleDate: string | null; completionDate: string | null;
  gross: number | null; changeOrders: number | null; totalRev: number | null;
  paymentMethod: null; deposit: null; progressPayments: null;
  totalPayments: number | null; balanceOwed: number | null;
  financialsFetchedAt: string | null; jpUrl: string | null;
}

export interface WeeklyJobSheet {
  rows: SheetRow[];
  generatedAt: string;
  sync: { startedAt: string; finishedAt: string | null; status: string } | null;
}

interface Row {
  jp_job_id: string; jp_customer_id: string | null; job_number: string | null; job_name: string | null;
  customer_name: string | null; address: string | null; city: string | null;
  division: string | null; trades: string | null; is_insurance: boolean;
  current_stage: string | null; stage_last_modified: Date | null;
  rep_names: string | null; sub_contractor_names: string | null;
  contract_signed_date: string | null; completion_date: string | null; first_install_day: string | null;
  crews: string[] | null;
  total_job_price: string | null; total_change_order_amount: string | null; total_job_revenue: string | null;
  total_payment_received: string | null; total_amount_owed: string | null;
  financials_fetched_at: Date | null;
}

const money = (v: string | null): number | null => (v === null ? null : Number(v));

export async function weeklyJobSheet(ctx: SessionContext): Promise<WeeklyJobSheet> {
  const rows = await withUser(dbApp(), ctx, async (c) => (await c.query<Row>(
    `SELECT j.jp_job_id, j.jp_customer_id, j.job_number, j.job_name, cu.customer_name, l.address, l.city,
            j.division, j.trades, j.is_insurance, j.current_stage, j.stage_last_modified,
            j.rep_names, j.sub_contractor_names,
            j.contract_signed_date::text, j.completion_date::text,
            (sch.first_start AT TIME ZONE $1)::date::text AS first_install_day,
            crew.names AS crews,
            j.total_job_price::text, j.total_change_order_amount::text, j.total_job_revenue::text,
            j.total_payment_received::text, j.total_amount_owed::text, j.financials_fetched_at
       FROM jp_job j
       LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
       LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
       LEFT JOIN LATERAL (
         SELECT min(s.start_at) AS first_start FROM jp_schedule s
          WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL) sch ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT n ORDER BY n) AS names
           FROM jp_schedule s, unnest(s.crew_names) AS n
          WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL) crew ON true
      WHERE j.stage_seen_at IS NOT NULL
      ORDER BY j.contract_signed_date DESC NULLS LAST, j.job_number`,
    [BOARD_TIMEZONE])).rows);

  const items: SheetRow[] = rows.map((r) => {
    const gross = money(r.total_job_price);
    const changeOrders = money(r.total_change_order_amount);
    const totalRev = money(r.total_job_revenue) ?? totalRevenue(gross, changeOrders);
    const totalPayments = money(r.total_payment_received);
    const base = {
      jobId: r.jp_job_id, customerId: r.jp_customer_id, jobNumber: r.job_number, jobName: r.job_name,
      customer: r.customer_name, address: r.address, city: r.city,
    };
    return {
      ...base,
      label: rowLabel(base),
      division: r.division, trades: r.trades, insurance: r.is_insurance,
      stage: r.current_stage, stageGroup: stageGroup(r.current_stage)?.key ?? null,
      stageSince: r.stage_last_modified ? r.stage_last_modified.toISOString() : null,
      salesRep: r.rep_names,
      sub: r.sub_contractor_names ?? (r.crews && r.crews.length ? r.crews.join(", ") : null),
      scheduledInstallDate: r.first_install_day, saleDate: r.contract_signed_date, completionDate: r.completion_date,
      gross, changeOrders, totalRev,
      paymentMethod: null, deposit: null, progressPayments: null,
      totalPayments,
      balanceOwed: money(r.total_amount_owed) ?? balanceOwed(totalRev, totalPayments, r.current_stage),
      financialsFetchedAt: r.financials_fetched_at ? r.financials_fetched_at.toISOString() : null,
      jpUrl: jobProgressUrl(r.jp_customer_id, r.jp_job_id),
    };
  });

  const sync = await withServiceRole(async (c) => {
    const { rows } = await c.query<{ started_at: Date; finished_at: Date | null; status: string }>(
      `SELECT started_at, finished_at, status FROM sync_run WHERE kind = 'job_stages' ORDER BY started_at DESC LIMIT 1`);
    const r = rows[0];
    return r ? { startedAt: r.started_at.toISOString(), finishedAt: r.finished_at ? r.finished_at.toISOString() : null, status: r.status } : null;
  }, "production:sheet-freshness", { quiet: true });

  return { rows: items, generatedAt: new Date().toISOString(), sync };
}
