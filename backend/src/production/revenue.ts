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
import { isInstallCode } from "@allied/shared/production";

export function arSettings(env = process.env) {
  const n = Number(env.AR_OVERDUE_DAYS);
  return { overdueDays: Number.isFinite(n) && n > 0 ? Math.round(n) : AR_OVERDUE_DAYS_DEFAULT };
}

export async function revenueReport(ctx: SessionContext, today = todayInBoardZone(), env = process.env) {
  const [jobs, sheet] = await Promise.all([loadJobs((fn) => withUser(dbApp(), ctx, fn)), weeklyJobSheet(ctx)]);
  return {
    ...revenueSummary(jobs, today, arSettings(env)),
    started: { rows: startedRows(sheet.rows), splitFrom: sheetSplitFrom(env) },
    ar: sheetAr(sheet.rows, today, arSettings(env).overdueDays),
  };
}

type SheetFeedRow = Awaited<ReturnType<typeof weeklyJobSheet>>["rows"][number];

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
export function startedRows(rows: SheetFeedRow[]) {
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
    }];
  });
}
