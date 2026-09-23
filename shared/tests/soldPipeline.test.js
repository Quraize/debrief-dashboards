import { describe, it, expect } from "vitest";
import { soldPipeline, pipelineTotals, inPipeline, bucketFor, derivedBlocker, expectedWeek, BUCKETS } from "../src/soldPipeline.js";
import { weekBounds } from "../src/production.js";

const TODAY = "2026-09-23"; // a Wednesday; the week is 9/21–9/27, next is 9/28–10/4
const job = (over = {}) => ({
  jobId: "j1", customerId: "c1", jobNumber: "2609-0001-01", customer: "Customer", city: "Wayne", address: "1 Main St",
  stage: "Install Accepted-> SUBMIT SS", contractSignedDate: "2026-09-10", contract: 10000, installDays: [], rep: "Jason", note: null, jpUrl: null,
  ...over,
});

describe("what is pipeline", () => {
  it("is a signed job that has not yet been paid; cancelled, lost and disqualified never are", () => {
    expect(inPipeline(job())).toBe(true);
    expect(inPipeline(job({ stage: "COMPLETED NEED FINAL PAYMENT!!" }))).toBe(true);
    expect(inPipeline(job({ stage: "Collections" }))).toBe(true);
    // Leaves at the first Paid stage or later — the "warranty" reading without banked money.
    for (const s of ["Paid New Roof", "Paid Complete 2026", "Warranty", "Client Satisfaction/Referrals", "Closed Warranty Claims"]) expect(inPipeline(job({ stage: s })), s).toBe(false);
    for (const s of ["Cancel: NO FOLLOW UP(MGR APPR)", "Job Lost DNS (MGR APPROVAL)", "DQ (MGR APPROVAL)", "Disqualified Lead"]) expect(inPipeline(job({ stage: s })), s).toBe(false);
    expect(inPipeline(job({ contractSignedDate: null }))).toBe(false);
  });
});

describe("buckets", () => {
  it("reads the calendar first and the stage second, so an unrecognised visit code cannot hide a scheduled job", () => {
    expect(bucketFor(job(), TODAY)).toBe("unscheduled");
    expect(bucketFor(job({ installDays: ["2026-09-30"] }), TODAY)).toBe("scheduled");
    expect(bucketFor(job({ installDays: ["2026-09-15"] }), TODAY)).toBe("inProduction");        // started last week
    expect(bucketFor(job({ stage: "Repairs Scheduled" }), TODAY)).toBe("scheduled");            // stage says so, no recognised visit
    expect(bucketFor(job({ stage: "Production Started" }), TODAY)).toBe("inProduction");
    expect(bucketFor(job({ stage: "Need Final Walk-Through" }), TODAY)).toBe("inProduction");
    expect(bucketFor(job({ stage: "COMPLETED NEED FINAL PAYMENT!!", installDays: ["2026-08-01"] }), TODAY)).toBe("awaitingPayment");
    expect(bucketFor(job({ stage: "Collections" }), TODAY)).toBe("awaitingPayment");
  });

  it("derives the blocker from the stage, and names the stage when it has no rule", () => {
    expect(derivedBlocker(job(), "unscheduled")).toBe("Awaiting sold-sheet handoff to production");
    expect(derivedBlocker(job({ stage: "Accepted/INS Claim Pending" }), "unscheduled")).toBe("Insurance claim pending");
    expect(derivedBlocker(job({ stage: "Accepted/No Deposit/Finance" }), "unscheduled")).toBe("Waiting on deposit / financing");
    expect(derivedBlocker(job({ stage: "On Hold/Financing Decline" }), "unscheduled")).toBe("Credit or financing declined — on hold");
    expect(derivedBlocker(job({ stage: "Approved New Installs" }), "unscheduled")).toBe("Approved — not yet on the calendar");
    expect(derivedBlocker(job({ stage: "Something New" }), "unscheduled")).toBe("Stage: Something New");
    expect(derivedBlocker(job(), "scheduled")).toBe("Scheduled");
    expect(derivedBlocker(job(), "awaitingPayment")).toBe("Awaiting final payment");
  });

  it("puts a multi-day install in the week it starts", () => {
    expect(expectedWeek("2026-09-25")).toBe("2026-09-21");   // a Friday start → that Monday's week
    expect(expectedWeek("2026-09-28")).toBe("2026-09-28");
    expect(expectedWeek(null)).toBeNull();
    expect(weekBounds("2026-09-23")).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(weekBounds("2026-09-23", 1)).toEqual({ from: "2026-09-28", to: "2026-10-04" });
  });
});

describe("soldPipeline — the report", () => {
  const jobs = [
    job({ jobId: "a", contractSignedDate: "2026-09-16", contract: 26749 }),                                          // unscheduled, handoff
    job({ jobId: "b", contractSignedDate: "2026-08-03", contract: 24000, stage: "Sales Review" }),                    // unscheduled, review
    job({ jobId: "c", contractSignedDate: "2026-09-01", contract: 58899, installDays: ["2026-09-24", "2026-09-25"] }), // scheduled, this week
    job({ jobId: "d", contractSignedDate: "2026-09-02", contract: 15000, installDays: ["2026-10-01"] }),              // scheduled, next week
    job({ jobId: "e", contractSignedDate: "2026-08-20", contract: 30000, installDays: ["2026-09-14", "2026-09-22"] }), // in production (started last week; continues this week — counts in ITS start week)
    job({ jobId: "f", contractSignedDate: "2026-07-01", contract: 12000, stage: "COMPLETED NEED FINAL PAYMENT!!" }),  // awaiting payment
    job({ jobId: "g", contractSignedDate: "2026-07-09", contract: null, stage: "Accepted/INS Claim Pending" }),       // unscheduled, no value
    job({ jobId: "h", contractSignedDate: "2026-06-01", contract: 40000, stage: "Paid New Roof" }),                  // left the pipeline
    job({ jobId: "i", contractSignedDate: "2026-06-02", contract: 9000, stage: "Cancel: FOLLOW UP (MGR APPR)" }),    // never pipeline
    job({ jobId: "k", contractSignedDate: "2025-11-27", contract: 20000, stage: "Accepted/No Deposit/Finance",
      note: { blocker: "Customer switching lenders", owner: "Pema", nextAction: "Call Friday", updatedBy: "pm@allied.test", updatedAt: "2026-09-22T10:00:00Z" } }),
  ];
  const p = soldPipeline(jobs, TODAY);

  it("adds up the CEO's numbers, with every bucket summing to the total", () => {
    expect(p.totals).toMatchObject({
      jobs: 8,
      totalPipeline: 26749 + 24000 + 58899 + 15000 + 30000 + 12000 + 0 + 20000,
      unscheduled: 26749 + 24000 + 0 + 20000, unscheduledJobs: 4, awaitingProduction: 4,
      unscheduledSoldThisMonth: 26749, unscheduledSoldThisMonthJobs: 1,   // only job a was sold in September
      scheduled: 58899 + 15000, scheduledJobs: 2,
      inProduction: 30000, inProductionJobs: 1,
      awaitingPayment: 12000, awaitingPaymentJobs: 1,
      expectedThisWeek: 58899, expectedThisWeekJobs: 1,   // e started on 9/14, so it is last week's, not this week's
      expectedNextWeek: 15000, expectedNextWeekJobs: 1,
      noContractValue: 1,
    });
    const t = p.totals;
    expect(t.unscheduled + t.scheduled + t.inProduction + t.awaitingPayment).toBe(t.totalPipeline);
    expect(t.unscheduledJobs + t.scheduledJobs + t.inProductionJobs + t.awaitingPaymentJobs).toBe(t.jobs);
    expect(p.thisWeek).toEqual({ from: "2026-09-21", to: "2026-09-27" });
  });

  it("lists oldest sale first so nothing stale can hide, and carries the detail columns", () => {
    expect(p.rows.map((r) => r.jobId)).toEqual(["k", "f", "g", "b", "e", "c", "d", "a"]);
    const k = p.rows[0];
    expect(k).toMatchObject({ bucket: "unscheduled", daysSinceSold: 300, blocker: "Customer switching lenders", blockerDerived: false, owner: "Pema", nextAction: "Call Friday", noteUpdatedBy: "pm@allied.test" });
    const a = p.rows.find((r) => r.jobId === "a");
    expect(a).toMatchObject({ bucket: "unscheduled", daysSinceSold: 7, blocker: "Awaiting sold-sheet handoff to production", blockerDerived: true, owner: null, nextAction: null, scheduledDate: null, expectedWeek: null });
    const c = p.rows.find((r) => r.jobId === "c");
    expect(c).toMatchObject({ bucket: "scheduled", scheduledDate: "2026-09-24", nextInstallDate: "2026-09-24", expectedWeek: "2026-09-21", blocker: "Scheduled" });
    const e = p.rows.find((r) => r.jobId === "e");
    expect(e).toMatchObject({ bucket: "inProduction", scheduledDate: "2026-09-14", nextInstallDate: null, expectedWeek: "2026-09-14" });
    expect(p.rows.find((r) => r.jobId === "g")).toMatchObject({ noContractValue: true, contract: null, blocker: "Insurance claim pending" });
    expect(BUCKETS.map((b) => b.key)).toEqual(["unscheduled", "scheduled", "inProduction", "awaitingPayment"]);
  });

  it("recomputes the cards for a filtered set of rows, keeping the real calendar weeks", () => {
    // The page filters by sold date or install date and adds up what is showing.
    expect(pipelineTotals(p.rows, TODAY)).toEqual(p.totals);
    const septemberSales = p.rows.filter((r) => r.contractSignedDate >= "2026-09-01");   // a, c, d
    expect(pipelineTotals(septemberSales, TODAY)).toMatchObject({ jobs: 3, totalPipeline: 26749 + 58899 + 15000, unscheduled: 26749, scheduled: 58899 + 15000, expectedThisWeek: 58899, expectedNextWeek: 15000, noContractValue: 0 });
    const thisWeekInstalls = p.rows.filter((r) => r.scheduledDate && r.scheduledDate >= "2026-09-21" && r.scheduledDate <= "2026-09-27"); // c only
    expect(pipelineTotals(thisWeekInstalls, TODAY)).toMatchObject({ jobs: 1, scheduled: 58899, unscheduled: 0, expectedThisWeek: 58899, expectedNextWeek: 0 });
    expect(pipelineTotals([], TODAY)).toMatchObject({ jobs: 0, totalPipeline: 0 });
  });

  it("is empty-safe", () => {
    expect(soldPipeline([], TODAY).totals).toMatchObject({ jobs: 0, totalPipeline: 0, unscheduled: 0, expectedThisWeek: 0, noContractValue: 0 });
    expect(soldPipeline(undefined, TODAY).rows).toEqual([]);
  });
});
