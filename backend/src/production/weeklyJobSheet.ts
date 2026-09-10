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
 *   U  payment method        methods used across the job's payments (jp_job_payment)
 *   Y  deposit               the first payment recorded on the job
 *   Z  progress payments     every later payment, summed
 *   AA total payments        jp_job.total_payment_received
 *   AB balance owed          jp_job.total_amount_owed, else T − AA
 */
import { dbApp, withUser, withServiceRole, type SessionContext } from "../db/client.js";
import { stageGroup } from "@allied/shared/jobStages";
import { totalRevenue, balanceOwed, rowLabel, paymentBreakdown, billBreakdown } from "@allied/shared/weeklyJobSheet";
import { BOARD_TIMEZONE, jobProgressUrl } from "./board.js";

export interface SheetRow {
  jobId: string; customerId: string | null; jobNumber: string | null; jobName: string | null;
  customer: string | null; address: string | null; city: string | null; label: string;
  division: string | null; trades: string | null; insurance: boolean;
  stage: string | null; stageGroup: string | null; stageSince: string | null;
  salesRep: string | null; sub: string | null;
  scheduledInstallDate: string | null; saleDate: string | null; completionDate: string | null;
  /** Every live production-schedule day on the job (office time), ascending; the next one on/after today. */
  installDates: string[]; nextInstallDate: string | null;
  gross: number | null; changeOrders: number | null; totalRev: number | null;
  paymentMethod: string | null; deposit: number | null; progressPayments: number | null; paymentsCount: number;
  totalPayments: number | null; balanceOwed: number | null;
  /** True when a live production schedule on the job has a crew assigned (AJ Sub Scheduled). */
  subScheduled: boolean;
  /** From vendor bills: material vendors (AD), a carting bill (AI), actual costs (BH..BL). */
  materialVendor: string | null; containerScheduled: boolean;
  actualMaterial: number | null; actualLabor: number | null; actualCarting: number | null; actualOther: number | null;
  billsCount: number; bills: BillJson[];
  financialsFetchedAt: string | null; paymentsFetchedAt: string | null; billsFetchedAt: string | null; jpUrl: string | null;
}

interface PaymentJson { id: string; amount: number | string; date: string | null; method: string | null; methodLabel: string | null; status: string | null; canceled: boolean }
export interface BillJson { vendorName: string | null; category: string; amount: number | string; date: string | null; billNumber: string | null }

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
  install_days: string[] | null; today: string;
  crews: string[] | null;
  total_job_price: string | null; total_change_order_amount: string | null; total_job_revenue: string | null;
  total_payment_received: string | null; total_amount_owed: string | null;
  financials_fetched_at: Date | null; payments_fetched_at: Date | null; bills_fetched_at: Date | null;
  payments: PaymentJson[]; bills: BillJson[]; sub_scheduled: boolean;
}

const money = (v: string | null): number | null => (v === null ? null : Number(v));

/** What "the week's jobs" means: which date must fall inside the range. */
export type WeekBasis = "install" | "sale" | "stage" | "any";
export const WEEK_BASES: WeekBasis[] = ["install", "sale", "stage", "any"];

export interface WeekFilter { from?: string | null; to?: string | null; basis?: WeekBasis }

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Validates a week filter from query parameters; returns an error message when it is malformed. */
export function parseWeekFilter(q: { from?: string; to?: string; basis?: string }): WeekFilter | { error: string } {
  const from = q.from || null;
  const to = q.to || null;
  if ((from && !ISO_DAY.test(from)) || (to && !ISO_DAY.test(to))) return { error: "from/to must be YYYY-MM-DD" };
  if (from && to && from > to) return { error: "from must not be after to" };
  const basis = (q.basis || "install") as WeekBasis;
  if (!WEEK_BASES.includes(basis)) return { error: `basis must be one of ${WEEK_BASES.join(", ")}` };
  return { from, to, basis };
}

const inRange = (day: string | null | undefined, f: WeekFilter): boolean =>
  !!day && (!f.from || day >= f.from) && (!f.to || day <= f.to);

/**
 * The rows that belong to a week. `install`: a production visit is scheduled
 * inside it (the sheet's weekly blocks are the crews' week); `sale`: sold
 * inside it; `stage`: the job's stage changed inside it; `any`: any of those.
 * No range = every row.
 */
export function filterSheetRows(rows: SheetRow[], f: WeekFilter): SheetRow[] {
  if (!f.from && !f.to) return rows;
  const byInstall = (r: SheetRow) => r.installDates.some((d) => inRange(d, f));
  const bySale = (r: SheetRow) => inRange(r.saleDate, f);
  const byStage = (r: SheetRow) => inRange(r.stageSince ? officeDay(r.stageSince) : null, f);
  const pick = { install: byInstall, sale: bySale, stage: byStage,
    any: (r: SheetRow) => byInstall(r) || bySale(r) || byStage(r) }[f.basis ?? "install"];
  return rows.filter(pick);
}

const officeDay = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BOARD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

export async function weeklyJobSheet(ctx: SessionContext): Promise<WeeklyJobSheet> {
  const rows = await withUser(dbApp(), ctx, async (c) => (await c.query<Row>(
    `SELECT j.jp_job_id, j.jp_customer_id, j.job_number, j.job_name, cu.customer_name, l.address, l.city,
            j.division, j.trades, j.is_insurance, j.current_stage, j.stage_last_modified,
            j.rep_names, j.sub_contractor_names,
            j.contract_signed_date::text, j.completion_date::text,
            (sch.first_start AT TIME ZONE $1)::date::text AS first_install_day,
            sch.days AS install_days, (now() AT TIME ZONE $1)::date::text AS today,
            crew.names AS crews,
            j.total_job_price::text, j.total_change_order_amount::text, j.total_job_revenue::text,
            j.total_payment_received::text, j.total_amount_owed::text,
            j.financials_fetched_at, j.payments_fetched_at, j.bills_fetched_at,
            pay.payments, bill.bills, coalesce(crew.any_crew, false) AS sub_scheduled
       FROM jp_job j
       LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
       LEFT JOIN jp_job_location l ON l.jp_job_id = j.jp_job_id
       LEFT JOIN LATERAL (
         SELECT min(s.start_at) AS first_start,
                array_agg(DISTINCT (s.start_at AT TIME ZONE $1)::date::text ORDER BY (s.start_at AT TIME ZONE $1)::date::text) AS days
           FROM jp_schedule s
          WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL) sch ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(DISTINCT n ORDER BY n) AS names, count(*) > 0 AS any_crew
           FROM jp_schedule s, unnest(s.crew_names) AS n
          WHERE s.jp_job_id = j.jp_job_id AND s.deleted_at IS NULL) crew ON true
       LEFT JOIN LATERAL (
         SELECT coalesce(json_agg(json_build_object(
                  'vendorName', b.vendor_name, 'category', b.category, 'amount', b.total_amount,
                  'date', b.bill_date::text, 'billNumber', b.bill_number)
                ORDER BY b.bill_date, b.jp_bill_id), '[]'::json) AS bills
           FROM jp_vendor_bill b
          WHERE b.jp_job_id = j.jp_job_id AND b.deleted_at IS NULL) bill ON true
       LEFT JOIN LATERAL (
         SELECT coalesce(json_agg(json_build_object(
                  'id', p.jp_payment_id, 'amount', p.amount, 'date', p.payment_date::text, 'method', p.method,
                  'methodLabel', p.method_label, 'status', p.status, 'canceled', p.canceled)
                ORDER BY p.payment_date, p.jp_payment_id), '[]'::json) AS payments
           FROM jp_job_payment p
          WHERE p.jp_job_id = j.jp_job_id AND p.deleted_at IS NULL) pay ON true
      WHERE j.stage_seen_at IS NOT NULL
      ORDER BY j.contract_signed_date DESC NULLS LAST, j.job_number`,
    [BOARD_TIMEZONE])).rows);

  const items: SheetRow[] = rows.map((r) => {
    const gross = money(r.total_job_price);
    const changeOrders = money(r.total_change_order_amount);
    const totalRev = money(r.total_job_revenue) ?? totalRevenue(gross, changeOrders);
    const totalPayments = money(r.total_payment_received);
    const pay = paymentBreakdown(r.payments ?? []);
    const bill = billBreakdown(r.bills ?? []);
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
      installDates: r.install_days ?? [],
      nextInstallDate: (r.install_days ?? []).find((d) => d >= r.today) ?? null,
      gross, changeOrders, totalRev,
      paymentMethod: pay.paymentMethod, deposit: pay.deposit, progressPayments: pay.progressPayments, paymentsCount: pay.count,
      totalPayments,
      balanceOwed: money(r.total_amount_owed) ?? balanceOwed(totalRev, totalPayments, r.current_stage),
      subScheduled: r.sub_scheduled,
      materialVendor: bill.materialVendor, containerScheduled: bill.containerBilled,
      actualMaterial: bill.actualMaterial, actualLabor: bill.actualLabor, actualCarting: bill.actualCarting, actualOther: bill.actualOther,
      billsCount: bill.count, bills: r.bills ?? [],
      financialsFetchedAt: r.financials_fetched_at ? r.financials_fetched_at.toISOString() : null,
      paymentsFetchedAt: r.payments_fetched_at ? r.payments_fetched_at.toISOString() : null,
      billsFetchedAt: r.bills_fetched_at ? r.bills_fetched_at.toISOString() : null,
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
