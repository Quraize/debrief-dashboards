import { describe, it, expect } from "vitest";
import { revenueRow, revenueRows, revenueTotals, revenueSummary, isStartedStage, isCompletedStage, livePayments, STATUSES } from "../src/revenueAr.js";

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
