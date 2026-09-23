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

export function arSettings(env = process.env) {
  const n = Number(env.AR_OVERDUE_DAYS);
  return { overdueDays: Number.isFinite(n) && n > 0 ? Math.round(n) : AR_OVERDUE_DAYS_DEFAULT };
}

export async function revenueReport(ctx: SessionContext, today = todayInBoardZone(), env = process.env) {
  const jobs = await loadJobs((fn) => withUser(dbApp(), ctx, fn));
  return revenueSummary(jobs, today, arSettings(env));
}
