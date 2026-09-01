import { describe, it, expect } from "vitest";
import {
  jpAppointmentStats, jpTwoLegStats, jpRevenueStats,
  jpSetterStats, jpRepStats, jpDebriefCoverage,
} from "../src/jpStats.js";

// Row factories mirror the jp_appointment / jp_job columns the sync writes.
// numeric columns arrive as strings (the backend's pg type parser returns
// NUMERIC raw), so revenue fixtures are deliberately strings.
const appt = (over = {}) => ({
  jp_appointment_id: "1",
  appointment_date: "2026-08-10",
  title: "ROOF EST",
  is_sales_type: true,
  is_insurance: false,
  has_result: false,
  two_leg_answer: null,
  sales_rep: "Rep A",
  appointment_setter: "Setter A",
  crm_lead_id: "1000-1",
  ...over,
});

const job = (over = {}) => ({
  jp_job_id: "10",
  contract_signed_date: "2026-08-15",
  division: "Roofing",
  total_job_revenue: "10000",
  ...over,
});

describe("jpAppointmentStats", () => {
  it("counts totals, sales-type split, and result coverage within the period", () => {
    const rows = [
      appt({ jp_appointment_id: "1", has_result: true }),
      appt({ jp_appointment_id: "2" }),
      appt({ jp_appointment_id: "3", is_sales_type: false, title: "WARRANTY CB" }),
      appt({ jp_appointment_id: "4", appointment_date: "2026-07-01" }), // outside period
    ];
    const s = jpAppointmentStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.total).toBe(3);
    expect(s.salesType).toBe(2);
    expect(s.nonSales).toBe(1);
    expect(s.withResult).toBe(1);
    expect(s.resultCoverageRate).toBe(50); // 1 of 2 sales-type
  });

  it("buckets weekly volume by Monday week start", () => {
    const rows = [
      appt({ jp_appointment_id: "1", appointment_date: "2026-08-03" }), // Mon
      appt({ jp_appointment_id: "2", appointment_date: "2026-08-09" }), // Sun same week
      appt({ jp_appointment_id: "3", appointment_date: "2026-08-10" }), // next Mon
    ];
    const s = jpAppointmentStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.weekly).toEqual([
      { week: "2026-08-03", total: 2, salesType: 2 },
      { week: "2026-08-10", total: 1, salesType: 1 },
    ]);
  });

  it("handles empty input", () => {
    const s = jpAppointmentStats([], "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.total).toBe(0);
    expect(s.resultCoverageRate).toBe(0);
    expect(s.weekly).toEqual([]);
  });
});

describe("jpTwoLegStats", () => {
  const rows = [
    appt({ jp_appointment_id: "1", two_leg_answer: "two_leg", has_result: true }),
    appt({ jp_appointment_id: "2", two_leg_answer: "two_leg", has_result: true }),
    appt({ jp_appointment_id: "3", two_leg_answer: "one_leg", has_result: true }),
    appt({ jp_appointment_id: "4", two_leg_answer: "other", has_result: true }),
    appt({ jp_appointment_id: "5" }), // unanswered
    appt({ jp_appointment_id: "6", two_leg_answer: "two_leg", is_insurance: true, has_result: true }),
  ];

  it("computes the rate as two-leg over decided answers, excluding 'other'", () => {
    const s = jpTwoLegStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.twoLeg).toBe(2);
    expect(s.oneLeg).toBe(1);
    expect(s.other).toBe(1);
    expect(s.rate).toBe(67); // 2 / (2+1)
  });

  it("excludes insurance records entirely, matching the app's retail Two-Leg convention", () => {
    const s = jpTwoLegStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.answered).toBe(4); // insurance row's answer not counted
  });

  it("reports answer coverage against sales-type non-insurance volume", () => {
    const s = jpTwoLegStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    // 5 sales-type non-insurance rows, 4 answered
    expect(s.coverageRate).toBe(80);
  });
});

describe("jpRevenueStats — signed-date attribution", () => {
  const rows = [
    job({ jp_job_id: "1", total_job_revenue: "32990" }),
    job({ jp_job_id: "2", total_job_revenue: "52250.50", division: "Siding" }),
    job({ jp_job_id: "3", total_job_revenue: null }), // signed, financials missing
    job({ jp_job_id: "4", contract_signed_date: "2026-07-20" }), // outside period
    job({ jp_job_id: "5", contract_signed_date: null }), // never signed
  ];

  it("filters by contract_signed_date and sums numeric-as-string revenue", () => {
    const s = jpRevenueStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.signedJobs).toBe(3);
    expect(s.withFinancials).toBe(2);
    expect(s.missingFinancials).toBe(1);
    expect(s.revenue).toBe(85240.5);
    expect(s.avgJob).toBe(Math.round(85240.5 / 2));
  });

  it("breaks revenue down by division", () => {
    const s = jpRevenueStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.byDivision).toEqual([
      { division: "Siding", jobs: 1, revenue: 52250.5 },
      { division: "Roofing", jobs: 2, revenue: 32990 },
    ]);
  });

  it("breaks revenue down by signed month", () => {
    const s = jpRevenueStats(rows, "Year to Date", "", "");
    expect(s.monthly).toEqual([
      { month: "2026-07", jobs: 1, revenue: 10000 },
      { month: "2026-08", jobs: 3, revenue: 85240.5 },
    ]);
  });
});

describe("jpSetterStats / jpRepStats", () => {
  const rows = [
    appt({ jp_appointment_id: "1", appointment_setter: "Ashley", has_result: true }),
    appt({ jp_appointment_id: "2", appointment_setter: "Ashley" }),
    appt({ jp_appointment_id: "3", appointment_setter: null, sales_rep: null }),
    appt({ jp_appointment_id: "4", sales_rep: "Rep B", two_leg_answer: "two_leg", has_result: true }),
  ];

  it("groups setter volume with result coverage, unattributed rows under Unassigned", () => {
    const s = jpSetterStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    const ashley = s.find((g) => g.name === "Ashley");
    expect(ashley).toMatchObject({ total: 2, salesType: 2, withResult: 1, resultCoverageRate: 50 });
    expect(s.find((g) => g.name === "Unassigned").total).toBe(1);
    expect(s[0].name).toBe("Ashley"); // sorted by volume
  });

  it("groups rep volume with two-leg counts", () => {
    const s = jpRepStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    const repB = s.find((g) => g.name === "Rep B");
    expect(repB).toMatchObject({ total: 1, twoLeg: 1, twoLegRate: 100 });
  });
});

describe("jpDebriefCoverage", () => {
  const jpRows = [
    appt({ jp_appointment_id: "1", crm_lead_id: "1000-1", appointment_date: "2026-08-10" }),
    appt({ jp_appointment_id: "2", crm_lead_id: "1000-2", appointment_date: "2026-08-11" }),
    appt({ jp_appointment_id: "3", crm_lead_id: null }), // can never match
    appt({ jp_appointment_id: "4", is_sales_type: false }), // excluded from the funnel
  ];
  const debriefs = [
    { crm_lead_id: "1000-1", appointment_date: "2026-08-10" },
    { crm_lead_id: "1000-2", appointment_date: "2026-07-01" }, // same lead, different visit
  ];

  it("matches on lead id + date, so a rehash on another date does not count as covered", () => {
    const s = jpDebriefCoverage(jpRows, debriefs, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.jpSalesType).toBe(3);
    expect(s.debriefed).toBe(1);
    expect(s.missing).toBe(2);
    expect(s.unmatchable).toBe(1);
    expect(s.coverageRate).toBe(33);
  });

  it("matches lead ids case-insensitively, like the KPI engine does", () => {
    const s = jpDebriefCoverage(
      [appt({ crm_lead_id: "ABC-1", appointment_date: "2026-08-10" })],
      [{ crm_lead_id: "abc-1", appointment_date: "2026-08-10" }],
      "Custom Range", "2026-08-01", "2026-08-31",
    );
    expect(s.debriefed).toBe(1);
  });
});
