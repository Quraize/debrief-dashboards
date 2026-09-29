import { describe, it, expect } from "vitest";
import { revenueRow, revenueRows, revenueTotals, revenueSummary, startedRevenue, expectedCollections, operationalAr, invoicedAr, expectedDayOf, sheetBalance, isStartedStage, isCompletedStage, livePayments, STATUSES } from "../src/revenueAr.js";

describe("invoicedAr — unpaid amounts already invoiced, by invoice date", () => {
  const inSept = (d) => d >= "2026-09-01" && d <= "2026-09-30";
  const rows = [
    { jobId: "guinto", customer: "Rolito Guinto", firstInstall: "2026-09-01", invoices: [
      { number: "667-1823", date: "2026-09-02", total: 20599, open: 0, status: "closed" },
      { number: "667-1832", date: "2026-09-15", total: 3600, open: 0, status: "closed" }] },
    { jobId: "diss", customer: "Lisa Diss", firstInstall: "2026-09-30", invoices: [{ number: "667-1900", date: "2026-09-30", total: 26749, open: 21249, status: "open" }] },
    { jobId: "old", customer: "Maryann Schnell", firstInstall: null, invoices: [{ number: "667-1100", date: "2026-01-27", total: 1000, open: 1000, status: "open" }] },
    { jobId: "willis", customer: "Robert Willis", firstInstall: "2026-09-29", invoices: [] },   // started, never invoiced
    { jobId: "future", customer: "Later", firstInstall: "2026-09-30", invoices: [] },          // not started yet on 9/29
    { jobId: "unread", customer: "Not read yet", firstInstall: "2026-09-15", invoices: [], invoicesChecked: false }, // the sync has not read it: not flagged
    { jobId: "void", customer: "Voided", firstInstall: "2026-09-10", invoices: [{ number: "x", date: "2026-09-10", total: 500, open: 500, status: "void" }] },
  ];
  it("sums the open balance of invoices dated in the period, and names started jobs with no invoice", () => {
    const a = invoicedAr(rows, inSept, "2026-09-29");
    expect(a).toMatchObject({ amount: 21249, openInvoices: 1, invoiced: 20599 + 3600 + 26749 + 500, invoices: 4, noInvoice: ["Robert Willis"] });
    expect(a.open).toEqual([{ customer: "Lisa Diss", number: "667-1900", date: "2026-09-30", open: 21249 }]);
    // All time: Schnell's January invoice too.
    expect(invoicedAr(rows, () => true, "2026-09-29").amount).toBe(22249);
    expect(invoicedAr(undefined, inSept, "2026-09-29")).toMatchObject({ amount: 0, invoices: 0, noInvoice: [] });
  });
});

describe("operationalAr — all unpaid value on started jobs, today", () => {
  const job = (over) => ({ jobId: "j", customer: "C", stage: "Production Started", pifStatus: "NO", firstInstall: "2026-09-15", gross: 20000, changeOrders: 0, deposit: 5000, progressPayments: null, ...over });
  it("counts started jobs not paid in full at the sheet balance, by calendar or by stage, and nothing else", () => {
    const ar = operationalAr([
      job({ jobId: "building" }),                                                                   // $15,000, in production
      job({ jobId: "old", stage: "COMPLETED NEED FINAL PAYMENT!!", firstInstall: null, gross: 1000, deposit: null }), // installed before our calendar: the stage says started — $1,000
      job({ jobId: "scheduled", stage: "Roof/Siding Scheduled", firstInstall: "2026-10-05" }),       // not started yet
      job({ jobId: "scheduledStarted", stage: "Roof/Siding Scheduled", firstInstall: "2026-09-28", gross: 8000, deposit: 1000 }), // the crew was there: $7,000
      job({ jobId: "paid", pifStatus: "YES", deposit: 20000 }),
      job({ jobId: "paidStage", stage: "Paid New Roof", pifStatus: "YES (ledger still shows a balance)" }),
      job({ jobId: "dead", stage: "Cancelled" }),
    ], "2026-09-29");
    expect(ar.rows.map((r) => r.jobId)).toEqual(["building", "scheduledStarted", "old"]);
    expect(ar).toMatchObject({ amount: 23000, jobs: 3, finished: { amount: 1000, jobs: 1 }, inProgress: { amount: 22000, jobs: 2 } });
    expect(operationalAr(undefined, "2026-09-29")).toMatchObject({ amount: 0, jobs: 0 });
  });
});

describe("expectedCollections — the balance due in a period", () => {
  const job = (over) => ({ jobId: "j", stage: "Production Started", pifStatus: "NO", gross: 20000, changeOrders: 1000, deposit: 5000, progressPayments: 6000, completionDate: null, lastInstall: "2026-09-30", ...over });
  const inWeek = (d) => d >= "2026-09-28" && d <= "2026-09-30";
  it("dates a job by its completion once finished, else its last install day, and sums the sheet balance", () => {
    expect(expectedDayOf(job({}))).toBe("2026-09-30");
    expect(expectedDayOf(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-29" }))).toBe("2026-09-29");
    expect(expectedDayOf(job({ completionDate: "2026-09-01" }))).toBe("2026-09-30");   // a target date on an open job is not a fact
    expect(sheetBalance(job({}))).toBe(10000);
    const e = expectedCollections([
      job({ jobId: "a" }),                                                   // due 9/30: $10,000
      job({ jobId: "b", pifStatus: "YES", deposit: 21000, progressPayments: null }), // paid in full: nothing due
      job({ jobId: "c", lastInstall: "2026-10-02" }),                          // next week
      job({ jobId: "d", stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-28", deposit: 20000, progressPayments: null }), // $1,000
    ], inWeek);
    expect(e.amount).toBe(11000);
    expect(e.rows.map((r) => r.jobId)).toEqual(["d", "a"]);
    expect(expectedCollections(undefined, inWeek)).toEqual({ amount: 0, jobs: 0, rows: [] });
  });
});

describe("startedRevenue — the Weekly Job Sheet's numbers", () => {
  // Three of September's reconciled jobs and one October one.
  const rows = [
    { jobId: "guinto", customer: "Rolito Guinto", stage: "Need Final Walk-Through", pifStatus: "YES", firstInstall: "2026-09-01", gross: 20599, changeOrders: 3600, totalRev: 24199 },
    { jobId: "willis", stage: "Roof/Siding Scheduled", pifStatus: "NO", firstInstall: "2026-09-29", gross: 21699, changeOrders: 0, totalRev: 21699 },
    { jobId: "diss", stage: "Paid New Roof", pifStatus: "YES (ledger still shows a balance)", firstInstall: "2026-09-30", gross: 26749, changeOrders: 0, totalRev: 26749 },
    { jobId: "htun", customer: "Zaw Htun", stage: "Paid New Roof", pifStatus: "YES", firstInstall: "2026-10-02", gross: 8000, changeOrders: null, totalRev: 8000 },
  ];
  it("adds each job once, splits started from still-to-start, and lists the sheet blocks newest first", () => {
    const s = startedRevenue(rows, "2026-09-29", "2026-08-31");
    expect(s).toMatchObject({ jobs: 4, gross: 77047, changeOrders: 3600, totalRev: 80647 });
    expect(s.started).toEqual({ jobs: 2, gross: 42298, changeOrders: 3600, totalRev: 45898 });
    expect(s.upcoming).toEqual({ jobs: 2, gross: 34749, changeOrders: 0, totalRev: 34749 });
    // The week of 9/28 is two sheet blocks: September's 9/28–9/30 and October's 10/1–10/4.
    expect(s.weeks.map((w) => [w.from, w.to, w.jobs, w.gross])).toEqual([
      ["2026-10-01", "2026-10-04", 1, 8000],
      ["2026-09-28", "2026-09-30", 2, 48448],
      ["2026-09-01", "2026-09-06", 1, 20599],
    ]);
  });
  it("counts paid in full the sheet's way: YES only, over Total Rev; a paid stage still owing is its own count", () => {
    const s = startedRevenue(rows, "2026-09-29", "2026-08-31");
    expect(s.paidInFull).toEqual({ jobs: 2, gross: 28599, changeOrders: 3600, totalRev: 32199 });
    expect(s.notPaidInFull.jobs).toBe(1);
    expect(s.paidStageOwed).toMatchObject({ jobs: 1, totalRev: 26749 });
    // Guinto is paid but still at the final walk-through; Htun is paid and closed.
    expect(s.paidNotClosed).toEqual(["Rolito Guinto"]);
  });

  it("owes what the sheet's rows owe: Gross + C.O. minus Deposit + Progress, added up", () => {
    const owedRows = [
      { jobId: "diss", firstInstall: "2026-09-30", gross: 26749, changeOrders: 0, deposit: 5500, progressPayments: null },
      { jobId: "faggello", firstInstall: "2026-09-30", gross: 27971, changeOrders: 0, deposit: 5594, progressPayments: 11188 },
      { jobId: "guinto", firstInstall: "2026-09-01", gross: 20599, changeOrders: 3600, deposit: 19199, progressPayments: 5000 },
    ];
    // Diss and Faggello as on the sheet's 9/28–9/30 rows; Guinto paid off, change order included.
    expect(startedRevenue(owedRows, "2026-09-29", "2026-08-31").remainingOwed).toEqual({
      amount: 21249 + 11189 + 0, totalRev: 26749 + 27971 + 24199, received: 5500 + 16782 + 24199, jobs: 2,
    });
  });

  it("is all zeros with no rows", () => {
    const zero = { jobs: 0, gross: 0, changeOrders: 0, totalRev: 0 };
    expect(startedRevenue([], "2026-09-29", "2026-08-31")).toEqual({
      ...zero, weeks: [], started: zero, upcoming: zero, paidInFull: zero, notPaidInFull: zero, paidStageOwed: zero, paidNotClosed: [],
      remainingOwed: { amount: 0, totalRev: 0, received: 0, jobs: 0 },
    });
    expect(startedRevenue(undefined, "2026-09-29").jobs).toBe(0);
  });
});

const TODAY = "2026-09-23"; // Wednesday; this week 9/21–9/27, next 9/28–10/4, month 2026-09
const pay = (date, amount, over = {}) => ({ date, amount, method: "Check", status: "paid", canceled: false, ...over });
const job = (over = {}) => ({
  jobId: "j", customer: "Customer", jobNumber: "2609-0001-01", stage: "Production Started", contractSignedDate: "2026-09-01",
  contract: 20000, received: 5000, owed: 15000, completionDate: null, installDays: ["2026-09-22", "2026-09-23"], payments: [pay("2026-09-01", 5000)], rep: "Jason",
  ...over,
});

describe("what is started, what is completed", () => {
  it("started = first install done and a production-or-later stage; completed and paid jobs count even with no calendar history", () => {
    expect(revenueRow(job(), TODAY)).toMatchObject({ status: "inProduction", startedDay: "2026-09-22", startedWeek: "2026-09-21" });
    expect(revenueRow(job({ installDays: ["2026-09-30"] }), TODAY)).toBeNull();                    // booked, not started
    expect(revenueRow(job({ stage: "Roof/Siding Scheduled", installDays: ["2026-09-22"] }), TODAY)).toBeNull(); // calendar says yes, stage says not yet
    expect(revenueRow(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", installDays: [] }), TODAY)).toMatchObject({ status: "completed", startedDay: null });
    expect(revenueRow(job({ stage: "Paid New Roof", installDays: [] }), TODAY)).toMatchObject({ status: "paid", paidInFull: true });
    for (const s of ["Cancel: FOLLOW UP (MGR APPR)", "Job Lost DNS (MGR APPROVAL)", "DQ (MGR APPROVAL)"]) expect(revenueRow(job({ stage: s }), TODAY), s).toBeNull();
    expect(revenueRow(job({ contractSignedDate: null }), TODAY)).toBeNull();
    expect(isStartedStage("Gutters/Solar/Punchlist")).toBe(true); expect(isStartedStage("Approved New Installs")).toBe(false);
    expect(isCompletedStage("Collections")).toBe(true); expect(isCompletedStage("Need Final Walk-Through")).toBe(false);
  });

  it("reads paid from the ledger or the stage, completion from the date else the last install, and ages the debt", () => {
    const done = revenueRow(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-08-10", received: 20000, owed: 0 }), TODAY);
    expect(done).toMatchObject({ status: "paid", paidInFull: true, completedDay: "2026-08-10", daysOutstanding: null, overdue: false, expectedDay: null });
    const owing = revenueRow(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-08-10", received: 5000, owed: 15000 }), TODAY);
    expect(owing).toMatchObject({ status: "completed", completedDay: "2026-08-10", daysOutstanding: 44, overdue: true, expectedDay: "2026-08-10" });
    expect(revenueRow(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-10", received: 5000, owed: 15000 }), TODAY)).toMatchObject({ daysOutstanding: 13, overdue: false });
    expect(revenueRow(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-10", received: 5000, owed: 15000 }), TODAY, { overdueDays: 10 }).overdue).toBe(true);
    // No completion date: the last install day stands in.
    expect(revenueRow(job({ stage: "Collections", completionDate: null, installDays: ["2026-07-01", "2026-07-03"] }), TODAY)).toMatchObject({ completedDay: "2026-07-03", daysOutstanding: 82 });
    // In production: the balance is expected in the week of the last scheduled install day.
    expect(revenueRow(job({ installDays: ["2026-09-22", "2026-09-26"] }), TODAY)).toMatchObject({ expectedDay: "2026-09-26", expectedWeek: "2026-09-21" });
    expect(revenueRow(job({ installDays: ["2026-09-22", "2026-10-01"] }), TODAY)).toMatchObject({ expectedWeek: "2026-09-28" });
  });

  it("flags what the numbers cannot see, and reads the deposit off the first live payment", () => {
    const r = revenueRow(job({ payments: [pay("2026-09-05", 1000, { canceled: true }), pay("2026-09-01", 5000), pay("2026-09-20", 2000)] }), TODAY);
    expect(r).toMatchObject({ deposit: 5000, depositDate: "2026-09-01", lastPaymentDate: "2026-09-20", paymentsCount: 2, noPayment: false });
    expect(revenueRow(job({ received: 0, payments: [] }), TODAY)).toMatchObject({ noPayment: true, deposit: null });
    expect(revenueRow(job({ stage: "Paid New Roof", received: 9000, owed: 3000 }), TODAY)).toMatchObject({ status: "paid", paidStageOwed: true });
    expect(revenueRow(job({ contract: null }), TODAY)).toMatchObject({ noContractValue: true, contract: null });
    expect(revenueRow(job({ received: null, owed: null, payments: [] }), TODAY)).toMatchObject({ noLedger: true, noPayment: true });
    expect(livePayments([pay("2026-01-01", 0), pay("2026-01-02", 10, { status: "Voided" })])).toEqual([]);
  });
});

describe("revenueTotals — the CEO's numbers", () => {
  const jobs = [
    job({ jobId: "a", contract: 10825, received: 3000, owed: 7825, installDays: ["2026-09-22"] }),                                        // started this week, in production; expected this week (completes 9/22 — past → still this week's day)
    job({ jobId: "b", contract: 58899, received: 20000, owed: 38899, installDays: ["2026-09-15", "2026-09-30"] }),                        // started last week, completes next week
    job({ jobId: "c", contract: 30000, received: 30000, owed: 0, stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-12", installDays: ["2026-09-08"] }), // paid
    job({ jobId: "d", contract: 12000, received: 8000, owed: 4000, stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-09-16", installDays: ["2026-09-09"] }), // AR, 7 days
    job({ jobId: "e", contract: 1000, received: 0, owed: 1000, stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-01-27", installDays: [], payments: [] }), // AR, overdue 90+, no payment ever
    job({ jobId: "f", contract: 15500, received: 0, owed: 15500, stage: "Gutters/Solar/Punchlist", installDays: ["2026-08-28"], payments: [] }), // August start, no payment
    job({ jobId: "g", contract: 40000, received: 37000, owed: 3000, stage: "Paid New Roof", installDays: ["2026-08-03"] }),               // paid stage, ledger owed
    job({ jobId: "h", contract: 9000, stage: "Approved New Installs", installDays: ["2026-10-06"] }),                                     // not started
  ];
  const p = revenueSummary(jobs, TODAY);

  it("adds up started revenue by calendar, paid and owed by the rows on screen, and AR by the whole book", () => {
    expect(p.totals).toMatchObject({
      startedThisWeek: 10825, startedThisWeekJobs: 1,
      startedMonthToDate: 10825 + 58899 + 30000 + 12000, startedMonthToDateJobs: 4,
      jobs: 7, paidInFull: 30000 + 40000, paidInFullJobs: 2,
      remainingOwed: 7825 + 38899 + 4000 + 1000 + 15500 + 3000, remainingOwedJobs: 6,
      expectedThisWeek: 7825, expectedThisWeekJobs: 1,
      expectedNextWeek: 38899, expectedNextWeekJobs: 1,
      totalAR: 4000 + 1000, totalARJobs: 2,
      overdueAR: 1000, overdueARJobs: 1,
      aging: { current: 4000, d31_60: 0, d61_90: 0, d90plus: 1000 },
      flags: { noPayment: 2, paidStageOwed: 1, paidStageOwedAmount: 3000, noContractValue: 0, noLedger: 0 },
    });
    expect(p.rows.map((r) => r.jobId)).toEqual(["a", "b", "d", "c", "f", "g", "e"]);   // newest start first; no-calendar job last
    expect(STATUSES.map((s) => s.key)).toEqual(["inProduction", "completed", "paid"]);
  });

  it("lets the page filter the started rows while debt and near-term cash stay whole-book", () => {
    const thisMonth = p.rows.filter((r) => r.startedDay && r.startedDay >= "2026-09-01");
    const t = revenueTotals(thisMonth, TODAY, {}, p.rows);
    expect(t).toMatchObject({ jobs: 4, paidInFull: 30000, remainingOwed: 7825 + 38899 + 4000, totalAR: 5000, overdueAR: 1000, expectedNextWeek: 38899 });
    expect(t.flags.noPayment).toBe(2);   // flags are whole-book too
    expect(revenueTotals([], TODAY)).toMatchObject({ jobs: 0, totalAR: 0, startedThisWeek: 0 });
    expect(revenueRows(undefined, TODAY)).toEqual([]);
  });
});
