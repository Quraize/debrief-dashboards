// Production Revenue + AR / Payment Summary — the cash question behind the
// pipeline. Of the work we STARTED, how much has turned into money, how much
// is still owed, and how much is about to come in.
//
// The rules, decided 2026-09-23:
//   started     the first install visit has happened and the job is in a
//               production, completed or paid stage — the same rule the
//               weekly sheet's MONTH AT A GLANCE uses, so the two agree;
//   completed   the STAGE says so (COMPLETED NEED FINAL PAYMENT, Collections,
//               or any Paid stage). The calendar is not consulted: many
//               finished jobs predate the calendar sync or use a visit code
//               we do not recognise, and reading AR off the calendar lost
//               them;
//   paid        the ledger is settled with money received, or the job sits in
//               a Paid stage;
//   expected    the balance owed, expected in the week the job completes —
//               its completion date, else its last scheduled install day.
//               JobProgress has no due dates on customer money, so this is
//               the rule, not a field;
//   overdue     owed on a completed job more than AR_OVERDUE_DAYS after
//               completion (30 by default).
// Two red counts never hide: started jobs with no payment recorded, and Paid
// stages whose ledger still shows a balance. The platform cannot create cash
// movement; it can make the gap impossible to ignore.

import { stageKey, isPaidStage } from "./jobStages.js";
import { isDisqualifiedStage } from "./leadFlow.js";
import { weekBounds } from "./production.js";
import { DEAD_STAGE, IN_PRODUCTION_STAGES, AWAITING_PAYMENT_STAGES } from "./soldPipeline.js";

export const AR_OVERDUE_DAYS_DEFAULT = 30;

const keys = (list) => new Set(list.map(stageKey));
const IN_PRODUCTION = keys(IN_PRODUCTION_STAGES), COMPLETED_UNPAID = keys(AWAITING_PAYMENT_STAGES);

export const isCompletedStage = (s) => COMPLETED_UNPAID.has(stageKey(s)) || isPaidStage(s);
/** The crew is at least on site: in production, completed, or paid. */
export const isStartedStage = (s) => IN_PRODUCTION.has(stageKey(s)) || isCompletedStage(s);

/** A missing figure stays null — distinct from a real zero. */
const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const round = (n) => Math.round(n * 100) / 100;
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** Payments that count: not cancelled or voided, positive, oldest first. */
export function livePayments(payments) {
  return (payments ?? [])
    .filter((p) => !p?.canceled && !/cancel|void/i.test(String(p?.status ?? "")))
    .map((p) => ({ ...p, amount: num(p.amount) }))
    .filter((p) => p.amount !== null && p.amount > 0)
    .sort((a, b) => String(a.date ?? "").localeCompare(String(b.date ?? "")));
}

export const STATUSES = [
  { key: "inProduction", label: "In production", tone: "blue" },
  { key: "completed", label: "Completed, unpaid", tone: "amber" },
  { key: "paid", label: "Paid in full", tone: "green" },
];

/**
 * One started job, with everything the summary needs.
 * @param job  { jobId, customer, jobNumber, stage, contractSignedDate, contract, received, owed,
 *               completionDate, installDays (install-code visits, ascending), payments, rep, ... }
 * @returns the row, or null when the job is not started (or not live at all)
 */
export function revenueRow(job, today, opts = {}) {
  const overdueDays = opts.overdueDays ?? AR_OVERDUE_DAYS_DEFAULT;
  const stage = String(job?.stage ?? "");
  if (!job?.contractSignedDate || DEAD_STAGE.test(stage) || isDisqualifiedStage(stage)) return null;
  const installDays = job.installDays ?? [];
  const startedDay = installDays[0] ?? null;
  const lastInstallDay = installDays.length ? installDays[installDays.length - 1] : null;
  // Started: the stage says the crew has been on site, and (when the calendar
  // knows the job) the first install day has passed. A completed or paid job
  // with no calendar history is still started — it was built.
  const completedStage = isCompletedStage(stage);
  const started = isStartedStage(stage) && (completedStage || (startedDay !== null && startedDay <= today));
  if (!started) return null;

  const contract = num(job.contract), received = num(job.received), owed = num(job.owed);
  const ledgerPaid = owed !== null && owed <= 0 && received !== null && received > 0;
  const paid = isPaidStage(stage) || (completedStage && ledgerPaid);
  const status = paid ? "paid" : completedStage ? "completed" : "inProduction";
  const completedDay = completedStage ? (job.completionDate ? String(job.completionDate).slice(0, 10) : lastInstallDay) : null;
  // When the money is expected: the completion week. Still in production →
  // the last scheduled install day; completed and unpaid → the day it finished
  // (already due — it is AR, and overdue once it ages past the threshold).
  const expectedDay = status === "paid" ? null : status === "completed" ? completedDay : lastInstallDay;
  const daysOutstanding = status === "completed" && completedDay ? Math.max(0, daysBetween(completedDay, today)) : null;
  const pays = livePayments(job.payments);
  return {
    ...job,
    contract, received, owed,
    status, started: true, startedDay, lastInstallDay, completedDay,
    startedWeek: startedDay ? weekBounds(startedDay).from : null,
    expectedDay, expectedWeek: expectedDay ? weekBounds(expectedDay).from : null,
    paidInFull: paid,
    deposit: pays[0]?.amount ?? null, depositDate: pays[0]?.date ?? null,
    lastPaymentDate: pays.length ? (pays[pays.length - 1].date ?? null) : null,
    paymentsCount: pays.length,
    daysOutstanding,
    overdue: status === "completed" && daysOutstanding !== null && daysOutstanding > overdueDays,
    // The two red flags, plus the two "we do not know" ones.
    noPayment: (received ?? 0) <= 0 && pays.length === 0,
    paidStageOwed: isPaidStage(stage) && owed !== null && owed > 0,
    noContractValue: contract === null || contract <= 0,
    noLedger: owed === null && received === null,
  };
}

/** Every started job as a row, newest start first. */
export function revenueRows(jobs, today, opts = {}) {
  const rows = (jobs ?? []).map((j) => revenueRow(j, today, opts)).filter(Boolean);
  rows.sort((a, b) => String(b.startedDay ?? "").localeCompare(String(a.startedDay ?? "")) || String(a.jobNumber ?? "").localeCompare(String(b.jobNumber ?? "")));
  return rows;
}

/**
 * The CEO's numbers. `rows` are the started jobs on screen (after any range
 * filter); `book` is every started job, because debt and near-term cash are a
 * snapshot of the whole book, whatever period the page is looking at.
 */
export function revenueTotals(rows, today, opts = {}, book = rows) {
  const overdueDays = opts.overdueDays ?? AR_OVERDUE_DAYS_DEFAULT;
  const thisWeek = weekBounds(today), nextWeek = weekBounds(today, 1);
  const month = today.slice(0, 7);
  const sum = (list, f) => round(list.reduce((n, r) => n + (f(r) ?? 0), 0));
  const contract = (r) => r.contract, owed = (r) => (r.owed !== null && r.owed > 0 ? r.owed : 0), received = (r) => r.received;
  const inWeek = (day, w) => day !== null && day >= w.from && day <= w.to;

  rows = rows ?? []; book = book ?? rows;
  const startedThisWeek = book.filter((r) => inWeek(r.startedDay, thisWeek));
  const startedMtd = book.filter((r) => r.startedDay !== null && r.startedDay.slice(0, 7) === month && r.startedDay <= today);
  const paidRows = rows.filter((r) => r.paidInFull);
  const owing = rows.filter((r) => r.owed !== null && r.owed > 0);
  const unpaid = (r) => r.status !== "paid" && r.owed !== null && r.owed > 0;
  const expectedThis = book.filter((r) => unpaid(r) && inWeek(r.expectedDay, thisWeek));
  const expectedNext = book.filter((r) => unpaid(r) && inWeek(r.expectedDay, nextWeek));
  const ar = book.filter((r) => r.status === "completed" && r.owed !== null && r.owed > 0);
  const overdue = ar.filter((r) => r.overdue);
  const bucket = (lo, hi) => sum(ar.filter((r) => r.daysOutstanding !== null && r.daysOutstanding > lo && (hi === null || r.daysOutstanding <= hi)), owed);
  return {
    today, thisWeek, nextWeek, overdueDays,
    // Started revenue — the calendar weeks and month, over the whole book.
    startedThisWeek: sum(startedThisWeek, contract), startedThisWeekJobs: startedThisWeek.length,
    startedMonthToDate: sum(startedMtd, contract), startedMonthToDateJobs: startedMtd.length,
    // The started jobs on screen: what they are worth, what came in, what is owed.
    jobs: rows.length, contract: sum(rows, contract), received: sum(rows, received),
    paidInFull: sum(paidRows, contract), paidInFullJobs: paidRows.length,
    remainingOwed: sum(owing, owed), remainingOwedJobs: owing.length,
    // Near-term cash and debt — snapshots of the whole book.
    expectedThisWeek: sum(expectedThis, owed), expectedThisWeekJobs: expectedThis.length,
    expectedNextWeek: sum(expectedNext, owed), expectedNextWeekJobs: expectedNext.length,
    totalAR: sum(ar, owed), totalARJobs: ar.length,
    overdueAR: sum(overdue, owed), overdueARJobs: overdue.length,
    aging: { current: bucket(-1, overdueDays), d31_60: bucket(overdueDays, 60), d61_90: bucket(60, 90), d90plus: bucket(90, null) },
    // What the numbers cannot see.
    flags: {
      noPayment: book.filter((r) => r.noPayment && r.status !== "paid").length,
      paidStageOwed: book.filter((r) => r.paidStageOwed).length,
      paidStageOwedAmount: sum(book.filter((r) => r.paidStageOwed), (r) => r.owed),
      noContractValue: book.filter((r) => r.noContractValue).length,
      noLedger: book.filter((r) => r.noLedger).length,
    },
  };
}

/** The whole report. */
export function revenueSummary(jobs, today, opts = {}) {
  const rows = revenueRows(jobs, today, opts);
  return { today, rows, totals: revenueTotals(rows, today, opts) };
}
