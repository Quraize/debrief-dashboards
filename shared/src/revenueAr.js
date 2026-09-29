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
import { weekBounds, sheetWeekOf } from "./production.js";
import { PIF_STATUS } from "./weeklyJobSheet.js";
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

/**
 * Revenue started — the Weekly Job Sheet's own numbers. `rows` are the sheet's
 * jobs ({ firstInstall, gross, changeOrders, totalRev, … }): each counted ONCE,
 * in the week its first install visit falls in (a multi-week job's money is
 * its first week's), $0 jobs already left out. Pass the rows of the period
 * being looked at; the result is its totals, split into what has already
 * started (first install day on or before `today`) and what is still to start,
 * and the sheet blocks it spans, newest first, each with its own subtotal.
 */
export function startedRevenue(rows, today, splitFrom) {
  const sum = (list, k) => round(list.reduce((n, r) => n + (num(r[k]) ?? 0), 0));
  const totals = (list) => ({ jobs: list.length, gross: sum(list, "gross"), changeOrders: sum(list, "changeOrders"), totalRev: sum(list, "totalRev") });
  rows = rows ?? [];
  const blocks = new Map();
  for (const r of rows) {
    const b = sheetWeekOf(r.firstInstall, splitFrom);
    const key = `${b.from}..${b.to}`;
    (blocks.get(key) ?? blocks.set(key, { ...b, rows: [] }).get(key)).rows.push(r);
  }
  const weeks = [...blocks.values()].sort((a, b) => b.from.localeCompare(a.from)).map((b) => ({ from: b.from, to: b.to, ...totals(b.rows) }));
  // Paid in full: the sheet's PAID-IN-FULL column, exactly as the KPIs
  // dashboard counts it — YES means JobProgress shows nothing owed with money
  // received, or a Paid stage. A Paid stage whose ledger still shows a
  // balance is neither YES nor NO there, and here it is its own count.
  const paid = rows.filter((r) => r.pifStatus === PIF_STATUS.yes);
  // Remaining owed: the sheet's own row formulas, added up the sheet's way —
  // Total Rev w/ C.O.s (Gross + Change Orders) minus Total Payments Received
  // (Deposit + Progress Payments), so it equals the Balance Owed on the
  // sheet's Weekly Total and Cumulative rows for the same jobs.
  const billed = (r) => (num(r.gross) ?? 0) + (num(r.changeOrders) ?? 0);
  const paidIn = (r) => (num(r.deposit) ?? 0) + (num(r.progressPayments) ?? 0);
  const owing = rows.filter((r) => billed(r) - paidIn(r) > 0);
  const remainingOwed = {
    amount: round(rows.reduce((n, r) => n + billed(r) - paidIn(r), 0)),
    totalRev: round(rows.reduce((n, r) => n + billed(r), 0)),
    received: round(rows.reduce((n, r) => n + paidIn(r), 0)),
    jobs: owing.length,
  };
  return {
    ...totals(rows),
    started: totals(rows.filter((r) => r.firstInstall <= today)),
    upcoming: totals(rows.filter((r) => r.firstInstall > today)),
    weeks,
    paidInFull: totals(paid),
    remainingOwed,
    notPaidInFull: totals(rows.filter((r) => r.pifStatus === PIF_STATUS.no)),
    paidStageOwed: totals(rows.filter((r) => r.pifStatus === PIF_STATUS.mismatch)),
    // Paid, but the stage still says the work is open (walk-through, punch list):
    // ready for the office to close out.
    paidNotClosed: paid.filter((r) => !isCompletedStage(r.stage)).map((r) => r.customer || r.label || r.jobId),
  };
}

/** The sheet's row formulas: Total Rev w/ C.O.s = Gross + C.O.; Total Paid = Deposit + Progress; Balance = the difference. */
export const sheetBalance = (r) => round((num(r.gross) ?? 0) + (num(r.changeOrders) ?? 0) - (num(r.deposit) ?? 0) - (num(r.progressPayments) ?? 0));

/**
 * The day a sheet job's balance is expected: the week it completes — its
 * completion date once the stage says it is finished, else its last
 * scheduled install day (the crew's last day on site). JobProgress has no due
 * dates on customer money, so this is the rule, not a field.
 */
export function expectedDayOf(r) {
  if (isCompletedStage(r.stage) && r.completionDate) return String(r.completionDate).slice(0, 10);
  return r.lastInstall ?? null;
}

/**
 * Expected collections for a period: the sheet balance of every job NOT paid
 * in full whose expected day falls in it. `inPeriod(day)` is the page's date
 * filter. Jobs are the sheet's (the same list Revenue Started reads).
 */
export function expectedCollections(rows, inPeriod) {
  const due = (rows ?? []).map((r) => ({ ...r, expectedDay: expectedDayOf(r), balance: sheetBalance(r) }))
    .filter((r) => r.pifStatus !== PIF_STATUS.yes && r.balance > 0 && r.expectedDay && inPeriod(r.expectedDay))
    .sort((a, b) => a.expectedDay.localeCompare(b.expectedDay));
  return { amount: round(due.reduce((n, r) => n + r.balance, 0)), jobs: due.length, rows: due };
}

/**
 * Operational AR (the PM's rule 1): all unpaid contract value we expect to
 * receive from active / started jobs, as of today — the broad cash picture.
 *   started   the first install day has passed, or the stage says the job is
 *             in production or finished (jobs installed before our copy of
 *             the calendar begins have no install day, the stage carries them);
 *   unpaid    not PAID-IN-FULL YES; a Paid stage whose ledger still shows a
 *             balance is left out here and counted apart (the office called it
 *             paid, so it is a ledger question, not expected cash);
 *   amount    the sheet's balance, Gross + C.O. − (Deposit + Progress).
 * Dead jobs and $0 jobs are not in the sheet's rows to begin with.
 */
export function operationalAr(rows, today) {
  const live = (rows ?? []).filter((r) => !DEAD_STAGE.test(String(r.stage ?? "")) && !isDisqualifiedStage(String(r.stage ?? "")));
  const started = (r) => (r.firstInstall && r.firstInstall <= today) || isStartedStage(r.stage);
  const owing = live.filter((r) => started(r) && r.pifStatus !== PIF_STATUS.yes && r.pifStatus !== PIF_STATUS.mismatch)
    .map((r) => ({ ...r, balance: sheetBalance(r), finished: isCompletedStage(r.stage) }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance);
  const sum = (list) => round(list.reduce((n, r) => n + r.balance, 0));
  const finished = owing.filter((r) => r.finished);
  return {
    amount: sum(owing), jobs: owing.length, rows: owing,
    // Of which: finished (awaiting final payment) vs still being built.
    finished: { amount: sum(finished), jobs: finished.length },
    inProgress: { amount: sum(owing.filter((r) => !r.finished)), jobs: owing.length - finished.length },
  };
}

/**
 * Invoiced AR (the PM's rule 2): unpaid amounts already invoiced, filtered by
 * the INVOICE date — which should be the job's start date when the process is
 * followed. `inPeriod(day)` is the page's date filter.
 *   amount       open balance of the invoices dated in the period
 *   invoiced     their total, and how many invoices
 *   noInvoice    jobs whose install STARTED in the period (and today or
 *                earlier) with no invoice at all: the process was not followed
 * A closed or cancelled/void invoice owes nothing, whatever its balance says.
 */
export function invoicedAr(rows, inPeriod, today) {
  const invoices = [];
  for (const r of rows ?? []) for (const inv of r.invoices ?? []) {
    if (inv.date && inPeriod(inv.date)) invoices.push({ ...inv, jobId: r.jobId, customer: r.customer || r.label || r.jobId });
  }
  const openOf = (i) => (/closed|void|cancel/i.test(String(i.status ?? "")) ? 0 : Math.max(0, num(i.open) ?? 0));
  const open = invoices.filter((i) => openOf(i) > 0).sort((a, b) => openOf(b) - openOf(a));
  // Only a job whose invoice list has been read can be said to have none.
  const noInvoice = (rows ?? []).filter((r) => r.invoicesChecked !== false && r.firstInstall && r.firstInstall <= today && inPeriod(r.firstInstall) && !(r.invoices ?? []).length)
    .map((r) => r.customer || r.label || r.jobId);
  return {
    amount: round(invoices.reduce((n, i) => n + openOf(i), 0)),
    openInvoices: open.length,
    invoiced: round(invoices.reduce((n, i) => n + (num(i.total) ?? 0), 0)),
    invoices: invoices.length,
    open: open.map((i) => ({ customer: i.customer, number: i.number, date: i.date, open: openOf(i) })),
    noInvoice,
  };
}

/**
 * Deposits missing (the PM's rule 3): a deposit is due when the job starts;
 * a started job with nothing in the sheet's Deposit column (blank or $0 — the
 * first payment recorded in JobProgress, whatever its method) is missing its
 * deposit. No exceptions, as on the sheet: a financed job whose lender has
 * not funded, or an insurance job with no check yet, is money not in either.
 * Started is Operational AR's test. A job the office marked paid is left out.
 */
export function depositsMissing(rows, today) {
  const started = (r) => (r.firstInstall && r.firstInstall <= today) || isStartedStage(r.stage);
  const missing = (rows ?? []).filter((r) => !DEAD_STAGE.test(String(r.stage ?? "")) && !isDisqualifiedStage(String(r.stage ?? ""))
      && started(r) && r.pifStatus !== PIF_STATUS.yes && r.pifStatus !== PIF_STATUS.mismatch && !((num(r.deposit) ?? 0) > 0))
    .sort((a, b) => String(a.firstInstall ?? "").localeCompare(String(b.firstInstall ?? "")));
  return {
    jobs: missing.length,
    contract: round(missing.reduce((n, r) => n + (num(r.gross) ?? 0) + (num(r.changeOrders) ?? 0), 0)),
    rows: missing.map((r) => ({ jobId: r.jobId, customer: r.customer || r.label || r.jobId, firstInstall: r.firstInstall ?? null, stage: r.stage ?? null,
      totalRev: round((num(r.gross) ?? 0) + (num(r.changeOrders) ?? 0)) })),
  };
}

/**
 * Progress payments due (the PM's rule 4). On the sheet the first payment is
 * the Deposit (Y) and every payment after it is a Progress Payment (Z). So
 * once a started job has its deposit, the rest of the contract — Total Rev
 * w/ C.O.s minus the deposit — is collected as progress payments, and what is
 * still uncollected is Total Rev − Deposit − Progress received: the sheet's
 * Balance Owed on that job. Jobs with no deposit are rule 3 (Deposits
 * Missing) and are not counted here, so nothing is counted twice. Finished
 * jobs awaiting their final payment are included: the final payment is a
 * progress payment on the sheet too.
 */
export function progressDue(rows, today) {
  const started = (r) => (r.firstInstall && r.firstInstall <= today) || isStartedStage(r.stage);
  const due = (rows ?? []).filter((r) => !DEAD_STAGE.test(String(r.stage ?? "")) && !isDisqualifiedStage(String(r.stage ?? ""))
      && started(r) && r.pifStatus !== PIF_STATUS.yes && r.pifStatus !== PIF_STATUS.mismatch && (num(r.deposit) ?? 0) > 0)
    .map((r) => {
      const totalRev = (num(r.gross) ?? 0) + (num(r.changeOrders) ?? 0), deposit = num(r.deposit) ?? 0, progress = num(r.progressPayments) ?? 0;
      return { jobId: r.jobId, customer: r.customer || r.label || r.jobId, stage: r.stage ?? null, firstInstall: r.firstInstall ?? null,
        afterDeposit: round(totalRev - deposit), progress: round(progress), due: round(totalRev - deposit - progress) };
    })
    .filter((r) => r.due > 0)
    .sort((a, b) => b.due - a.due);
  const sum = (k, list = due) => round(list.reduce((n, r) => n + r[k], 0));
  const none = due.filter((r) => r.progress <= 0);
  return {
    amount: sum("due"), jobs: due.length, afterDeposit: sum("afterDeposit"), collected: sum("progress"),
    // Production ahead of collections: started, deposit in, not one progress payment yet.
    noneYet: { amount: sum("due", none), jobs: none.length, names: none.map((r) => r.customer) },
    rows: due,
  };
}

/** One line, for a hover: how a job's expected payment date is worked out. */
export const EXPECTED_DATE_RULE =
  "JobProgress has no payment due dates, so we expect a job's balance when the job finishes: its completion date once the stage says it is finished, otherwise its last scheduled install day.";

/**
 * Expected collections from today (the PM's rule 6): Today, the next 7 days
 * and the next 14 days, CUMULATIVE (7 includes today; 14 includes the 7), by
 * job, amount, owner and expected payment date — plus what was expected
 * before today and has not come in, so nothing late hides.
 *   date    expectedDayOf (and `basis`: "completion" or "lastInstall")
 *   amount  the sheet balance; only jobs not paid in full
 *   owner   the Sold-Job Pipeline's Owner (`ownerOf(jobId)`); when the team
 *           has not set one, the job's sales rep stands in (`ownerSource`
 *           "rep"), and with neither it is "none"
 */
export function expectedSchedule(rows, today, ownerOf = () => null) {
  const addDays = (day, n) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const to7 = addDays(today, 6), to14 = addDays(today, 13);
  const all = (rows ?? [])
    .filter((r) => !DEAD_STAGE.test(String(r.stage ?? "")) && r.pifStatus !== PIF_STATUS.yes && r.pifStatus !== PIF_STATUS.mismatch)
    .map((r) => {
      const set = ownerOf(r.jobId);
      const day = expectedDayOf(r);
      return {
        jobId: r.jobId, customer: r.customer || r.label || r.jobId, expectedDay: day, amount: sheetBalance(r),
        basis: day && isCompletedStage(r.stage) && r.completionDate ? "completion" : "lastInstall",
        owner: set || r.salesRep || null, ownerSource: set ? "pipeline" : r.salesRep ? "rep" : "none",
      };
    })
    .filter((r) => r.amount > 0 && r.expectedDay)
    .sort((a, b) => a.expectedDay.localeCompare(b.expectedDay) || b.amount - a.amount);
  const pack = (list, extra = {}) => ({ amount: round(list.reduce((n, r) => n + r.amount, 0)), jobs: list.length, rows: list, ...extra });
  return {
    today: pack(all.filter((r) => r.expectedDay === today), { from: today, to: today }),
    next7: pack(all.filter((r) => r.expectedDay >= today && r.expectedDay <= to7), { from: today, to: to7 }),
    next14: pack(all.filter((r) => r.expectedDay >= today && r.expectedDay <= to14), { from: today, to: to14 }),
    pastDue: pack(all.filter((r) => r.expectedDay < today)),
  };
}

/** The whole report. */
export function revenueSummary(jobs, today, opts = {}) {
  const rows = revenueRows(jobs, today, opts);
  return { today, rows, totals: revenueTotals(rows, today, opts) };
}
