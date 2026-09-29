/**
 * Production Revenue + AR / Payment Summary.
 *
 * The same job list the Sold-Job Pipeline reads, handed to the shared cash
 * rules (shared/src/revenueAr.js). Read under the caller's identity; the
 * route gate says who that may be (management).
 */
import { dbApp, withUser, type SessionContext } from "../db/client.js";
import { loadJobs } from "./pipeline.js";
import { todayInBoardZone } from "./board.js";
import { revenueSummary, revenueRow, revenueTotals, AR_OVERDUE_DAYS_DEFAULT } from "@allied/shared/revenueAr";
import { weeklyJobSheet } from "./weeklyJobSheet.js";
import { firstInstallDay, bringsMoney, sheetSplitFrom } from "./sheetPlan.js";
import { isInstallCode, INSTALL_CODES } from "@allied/shared/production";

export function arSettings(env = process.env) {
  const n = Number(env.AR_OVERDUE_DAYS);
  return { overdueDays: Number.isFinite(n) && n > 0 ? Math.round(n) : AR_OVERDUE_DAYS_DEFAULT };
}

export async function revenueReport(ctx: SessionContext, today = todayInBoardZone(), env = process.env) {
  const [jobs, sheet, invoices, owners, crewDone] = await Promise.all([
    loadJobs((fn) => withUser(dbApp(), ctx, fn)), weeklyJobSheet(ctx), loadInvoices(ctx), loadOwners(ctx), loadCrewDone(ctx)]);
  return {
    ...revenueSummary(jobs, today, arSettings(env)),
    started: {
      rows: startedRows(sheet.rows, invoices).map((r) => ({ ...r, owner: owners.get(r.jobId) ?? null, crewDone: crewDone.has(r.jobId) })),
      splitFrom: sheetSplitFrom(env),
    },
    ar: sheetAr(sheet.rows, today, arSettings(env).overdueDays),
  };
}

type SheetFeedRow = Awaited<ReturnType<typeof weeklyJobSheet>>["rows"][number];
export interface InvoiceLite { number: string | null; date: string | null; dueDate: string | null; total: number; open: number | null; status: string | null }

/**
 * Jobs the crew has finished by the calendar: at least one install visit, and
 * every install visit in the past and marked completed. Completed but Unpaid
 * uses it to catch a finished job whose stage was never moved on.
 */
async function loadCrewDone(ctx: SessionContext): Promise<Set<string>> {
  const rows = await withUser(dbApp(), ctx, async (c) => (await c.query<{ jp_job_id: string }>(
    `SELECT jp_job_id FROM jp_schedule
      WHERE deleted_at IS NULL AND jp_job_id IS NOT NULL
        AND upper(replace(replace(coalesce(job_type_code, ''), ' ', ''), '/', '+')) = ANY($1::text[])
      GROUP BY jp_job_id
     HAVING bool_and(is_completed AND start_at < now())`, [INSTALL_CODES])).rows);
  return new Set(rows.map((r) => r.jp_job_id));
}

/** The Owner managers set on the Sold-Job Pipeline, by job (job_pipeline_note, 0030). */
async function loadOwners(ctx: SessionContext): Promise<Map<string, string>> {
  const rows = await withUser(dbApp(), ctx, async (c) => (await c.query<{ jp_job_id: string; owner: string }>(
    `SELECT jp_job_id, owner FROM job_pipeline_note WHERE coalesce(trim(owner), '') <> ''`)).rows);
  return new Map(rows.map((r) => [r.jp_job_id, r.owner.trim()]));
}

/** Every live invoice JobProgress has for our jobs, by job (jp_job_invoice, 0033). */
async function loadInvoices(ctx: SessionContext): Promise<{ byJob: Map<string, InvoiceLite[]>; checked: Set<string> }> {
  return withUser(dbApp(), ctx, async (c) => {
    const rows = (await c.query<{ jp_job_id: string; invoices: InvoiceLite[] }>(
      `SELECT jp_job_id, json_agg(json_build_object(
                'number', invoice_number, 'date', invoice_date::text, 'dueDate', due_date::text,
                'total', total_amount, 'open', open_balance, 'status', status)
              ORDER BY invoice_date, invoice_number) AS invoices
         FROM jp_job_invoice WHERE deleted_at IS NULL GROUP BY jp_job_id`)).rows;
    // Jobs whose invoice list has been read at least once: only these can be "started with no invoice".
    const checked = (await c.query<{ jp_job_id: string }>(`SELECT jp_job_id FROM jp_job WHERE invoices_fetched_at IS NOT NULL`)).rows;
    return {
      byJob: new Map(rows.map((r) => [r.jp_job_id, r.invoices.map((i) => ({ ...i, total: Number(i.total), open: i.open === null ? null : Number(i.open) }))])),
      checked: new Set(checked.map((r) => r.jp_job_id)),
    };
  });
}

/**
 * AR as of today, over every job the Weekly Job Sheet knows, by the SAME rule
 * and mapping as the sheet's KPIs dashboard (dashboardSheet.ts, "Overdue"):
 * finished jobs still owing, overdue once more than `overdueDays` past
 * completion. Kept identical on purpose — a test holds the two together.
 */
export function sheetAr(rows: SheetFeedRow[], today: string, overdueDays: number) {
  const arRows = rows.map((r) => revenueRow({
    jobId: r.jobId, contractSignedDate: r.saleDate, stage: r.stage, contract: r.totalRev, received: r.totalPayments, owed: r.balanceOwed,
    completionDate: r.completionDate, installDays: [...new Set((r.visits ?? []).filter((v) => isInstallCode(v.code)).map((v) => v.day))].sort(), payments: [],
  }, today, { overdueDays })).filter((x): x is NonNullable<typeof x> => x !== null);
  const t = revenueTotals(arRows, today, { overdueDays }, arRows);
  const byId = new Map(rows.map((r) => [r.jobId, r]));
  const list = arRows.filter((r) => r.status === "completed" && r.owed !== null && r.owed > 0)
    .map((r) => ({ jobId: r.jobId, customer: byId.get(r.jobId)?.customer ?? null, label: byId.get(r.jobId)?.label ?? null, owed: r.owed, completedDay: r.completedDay, daysOutstanding: r.daysOutstanding, overdue: r.overdue }))
    .sort((a, b) => (b.daysOutstanding ?? 0) - (a.daysOutstanding ?? 0));
  return { overdueDays, totalAR: t.totalAR, totalARJobs: t.totalARJobs, overdueAR: t.overdueAR, overdueARJobs: t.overdueARJobs, aging: t.aging, rows: list };
}

/**
 * Revenue started, read off the Weekly Job Sheet's own feed and rules, so the
 * page and the sheet can never disagree: every job that brings in money, once,
 * at its first install day (a multi-week job's money is its first week's).
 * A job with no install on our copy of the calendar (installed before it
 * begins) comes with firstInstall null: the period cards skip it, and
 * Operational AR counts it as started by its stage.
 */
export function startedRows(rows: SheetFeedRow[], invoices: { byJob: Map<string, InvoiceLite[]>; checked: Set<string> } = { byJob: new Map(), checked: new Set() }) {
  return rows.filter(bringsMoney).flatMap((r) => {
    const firstInstall = firstInstallDay(r);
    const lastInstall = r.visits.filter((v) => isInstallCode(v.code)).map((v) => v.day).sort().at(-1) ?? null;
    return [{
      jobId: r.jobId, label: r.label, customer: r.customer, jobNumber: r.jobNumber, city: r.city, address: r.address,
      stage: r.stage, salesRep: r.salesRep, firstInstall, gross: r.gross, changeOrders: r.changeOrders, totalRev: r.totalRev, jpUrl: r.jpUrl,
      // The sheet's PAID-IN-FULL answer (YES / NO / YES with a ledger balance), and the money behind it.
      pifStatus: r.pifStatus, received: r.totalPayments, owed: r.balanceOwed,
      // The sheet's Deposit and Progress Payment columns (its Total Payments Received is their sum).
      deposit: r.deposit, progressPayments: r.progressPayments,
      // When its balance is expected: see expectedDayOf (shared/revenueAr.js).
      completionDate: r.completionDate, lastInstall,
      invoices: invoices.byJob.get(r.jobId) ?? [], invoicesChecked: invoices.checked.has(r.jobId),
    }];
  });
}
