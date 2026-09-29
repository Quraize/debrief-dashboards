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
import { revenueSummary, AR_OVERDUE_DAYS_DEFAULT } from "@allied/shared/revenueAr";
import { weeklyJobSheet } from "./weeklyJobSheet.js";
import { firstInstallDay, bringsMoney, sheetSplitFrom } from "./sheetPlan.js";

export function arSettings(env = process.env) {
  const n = Number(env.AR_OVERDUE_DAYS);
  return { overdueDays: Number.isFinite(n) && n > 0 ? Math.round(n) : AR_OVERDUE_DAYS_DEFAULT };
}

export async function revenueReport(ctx: SessionContext, today = todayInBoardZone(), env = process.env) {
  const [jobs, sheet] = await Promise.all([loadJobs((fn) => withUser(dbApp(), ctx, fn)), weeklyJobSheet(ctx)]);
  return { ...revenueSummary(jobs, today, arSettings(env)), started: { rows: startedRows(sheet.rows), splitFrom: sheetSplitFrom(env) } };
}

/**
 * Revenue started, read off the Weekly Job Sheet's own feed and rules, so the
 * page and the sheet can never disagree: every job that brings in money, once,
 * at its first install day (a multi-week job's money is its first week's).
 */
export function startedRows(rows: Awaited<ReturnType<typeof weeklyJobSheet>>["rows"]) {
  return rows.filter(bringsMoney).flatMap((r) => {
    const firstInstall = firstInstallDay(r);
    return firstInstall ? [{
      jobId: r.jobId, label: r.label, customer: r.customer, jobNumber: r.jobNumber, city: r.city, address: r.address,
      stage: r.stage, salesRep: r.salesRep, firstInstall, gross: r.gross, changeOrders: r.changeOrders, totalRev: r.totalRev, jpUrl: r.jpUrl,
      // The sheet's PAID-IN-FULL answer (YES / NO / YES with a ledger balance), and the money behind it.
      pifStatus: r.pifStatus, received: r.totalPayments, owed: r.balanceOwed,
      // The sheet's Deposit and Progress Payment columns (its Total Payments Received is their sum).
      deposit: r.deposit, progressPayments: r.progressPayments,
    }] : [];
  });
}
