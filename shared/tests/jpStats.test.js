import { describe, it, expect } from "vitest";
import {
  jpAppointmentStats, jpTwoLegStats, jpRevenueStats,
  jpSetterStats, jpRepStats, jpDebriefCoverage, classifyNoResult,
  jpSalesFunnel, jobTypeFromDivision,
} from "../src/jpStats.js";

// Row factories mirror the jp_appointment / jp_job columns the sync writes.
// numeric columns arrive as strings (the backend's pg type parser returns
// NUMERIC raw), so revenue fixtures are deliberately strings.
const appt = (over = {}) => ({
  jp_appointment_id: "1",
  appointment_date: "2026-08-10",
  title: "ROOF EST",
  division: "ACR Roofing Division",
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

const ran = (over = {}) => appt({ has_result: true, result_option_name: "Demo No Sale", ...over });

describe("jpAppointmentStats", () => {
  it("counts totals, sales-type split, and result coverage within the period", () => {
    const rows = [
      ran({ jp_appointment_id: "1" }),
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

  it("headline Appointments = run: calendar − non-sales − no-shows − no result (the July 2026 formula)", () => {
    const rows = [
      ran({ jp_appointment_id: "1", result_option_name: "$ale!!!" }),
      ran({ jp_appointment_id: "2", result_option_name: "Demo No Sale" }),
      ran({ jp_appointment_id: "3", result_option_name: "No Demo" }),
      ran({ jp_appointment_id: "4", result_option_name: "No See" }),      // no-show: not run
      appt({ jp_appointment_id: "5", title: "CANCELLED ROOF EST" }),         // cancelled: not run
      appt({ jp_appointment_id: "6", is_sales_type: false, title: "FINAL WALK THROUGH" }),
    ];
    const s = jpAppointmentStats(rows, "Custom Range", "2026-08-01", "2026-08-31", new Date("2026-09-15T12:00:00"));
    expect(s).toMatchObject({ total: 6, run: 3, nonSales: 1, noShows: 1, noResult: 1, awaitingResult: 0, upcoming: 0, salesType: 5 });
    expect(s.run + s.nonSales + s.noShows + s.noResult).toBe(s.total); // the buckets always reconcile
  });

  it("splits missing results into awaiting / upcoming / cancelled-or-stale, relative to today", () => {
    const now = new Date("2026-08-20T15:00:00");
    const rows = [
      appt({ jp_appointment_id: "1", appointment_date: "2026-08-19" }),                    // held yesterday, form not filled → awaiting
      appt({ jp_appointment_id: "2", appointment_date: "2026-08-06" }),                    // 14 days ago → still awaiting (inclusive)
      appt({ jp_appointment_id: "3", appointment_date: "2026-08-05" }),                    // 15 days ago → no result
      appt({ jp_appointment_id: "4", appointment_date: "2026-08-20" }),                    // today → upcoming
      appt({ jp_appointment_id: "5", appointment_date: "2026-08-25" }),                    // later → upcoming
      appt({ jp_appointment_id: "6", appointment_date: "2026-08-19", title: "CANCELLED - ROOF EST" }), // cancelled, any age
      ran({ jp_appointment_id: "7", appointment_date: "2026-08-19" }),                     // run
    ];
    const s = jpAppointmentStats(rows, "Custom Range", "2026-08-01", "2026-08-31", now);
    expect(s).toMatchObject({ total: 7, run: 1, awaitingResult: 2, upcoming: 2, noResult: 2, noShows: 0, nonSales: 0 });
    expect(s.run + s.nonSales + s.noShows + s.awaitingResult + s.upcoming + s.noResult).toBe(s.total);
    expect(classifyNoResult(appt({ appointment_date: "2026-08-19" }), now)).toBe("awaiting");
    expect(classifyNoResult(appt({ appointment_date: "2026-07-01" }), now)).toBe("no_result");
  });

  it("buckets weekly volume by Monday week start", () => {
    const rows = [
      ran({ jp_appointment_id: "1", appointment_date: "2026-08-03" }), // Mon
      appt({ jp_appointment_id: "2", appointment_date: "2026-08-09" }), // Sun same week, no result
      ran({ jp_appointment_id: "3", appointment_date: "2026-08-10" }), // next Mon
    ];
    const s = jpAppointmentStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.weekly).toEqual([
      { week: "2026-08-03", total: 2, salesType: 2, run: 1 },
      { week: "2026-08-10", total: 1, salesType: 1, run: 1 },
    ]);
  });

  it("handles empty input", () => {
    const s = jpAppointmentStats([], "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.total).toBe(0);
    expect(s.resultCoverageRate).toBe(0);
    expect(s.weekly).toEqual([]);
  });
});

describe("jpTwoLegStats — the sales manager's rule", () => {
  const rows = [
    ran({ jp_appointment_id: "1", two_leg_answer: "two_leg" }),
    ran({ jp_appointment_id: "2", two_leg_answer: "two_leg" }),
    ran({ jp_appointment_id: "3", two_leg_answer: "one_leg" }),
    ran({ jp_appointment_id: "4", two_leg_answer: "other" }),
    ran({ jp_appointment_id: "5" }),                                         // run, form unanswered: counts against the rate
    ran({ jp_appointment_id: "6", two_leg_answer: "two_leg", is_insurance: true }),                   // insurance: out
    ran({ jp_appointment_id: "7", two_leg_answer: "two_leg", division: "ACR Service/Repair Division" }), // repair: out
    ran({ jp_appointment_id: "8", two_leg_answer: "two_leg", division: "ACR Siding Only Division" }),   // siding: in
    appt({ jp_appointment_id: "9", two_leg_answer: "two_leg" }),                                     // not run (no result): out
  ];

  it("divides two-leg by ALL retail appointments run — roofing, roof & siding, siding only", () => {
    const s = jpTwoLegStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.eligible).toBe(6);   // rows 1–5 and 8
    expect(s.twoLeg).toBe(3);     // 1, 2, 8
    expect(s.oneLeg).toBe(1);
    expect(s.other).toBe(1);
    expect(s.unanswered).toBe(1);
    expect(s.rate).toBe(50);      // 3 / 6, not 3 / (3+1)
  });

  it("reports how many of the eligible forms were answered", () => {
    const s = jpTwoLegStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.answered).toBe(5);
    expect(s.coverageRate).toBe(83);
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
    ran({ jp_appointment_id: "1", appointment_setter: "Ashley" }),
    appt({ jp_appointment_id: "2", appointment_setter: "Ashley" }),
    appt({ jp_appointment_id: "3", appointment_setter: null, sales_rep: null }),
    ran({ jp_appointment_id: "4", sales_rep: "Rep B", two_leg_answer: "two_leg" }),
    ran({ jp_appointment_id: "5", sales_rep: "Rep B", result_option_name: "No See" }),
  ];

  it("groups setter volume with run count and result coverage, unattributed rows under Unassigned", () => {
    const s = jpSetterStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    const ashley = s.find((g) => g.name === "Ashley");
    expect(ashley).toMatchObject({ total: 2, run: 1, salesType: 2, withResult: 1, resultCoverageRate: 50 });
    expect(s.find((g) => g.name === "Unassigned").total).toBe(1);
    expect(s[0].name).toBe("Ashley"); // sorted by volume
  });

  it("groups rep volume with run count (no-shows excluded) and two-leg counts", () => {
    const s = jpRepStats(rows, "Custom Range", "2026-08-01", "2026-08-31");
    const repB = s.find((g) => g.name === "Rep B");
    expect(repB).toMatchObject({ total: 2, run: 1, twoLeg: 1, twoLegRate: 100 });
  });
});

describe("jobTypeFromDivision — the sheet's rows from CRM division names", () => {
  it("maps the ACR divisions", () => {
    expect(jobTypeFromDivision("ACR Roofing Division")).toBe("Roof Replacement");
    expect(jobTypeFromDivision("ACR Roofing & Siding Division")).toBe("Roof & Siding");
    expect(jobTypeFromDivision("ACR Siding Only Division")).toBe("Siding Only");
    expect(jobTypeFromDivision("ACR Service/Repair Division")).toBe("Roof Repair");
    expect(jobTypeFromDivision("ACR Commercial Roofing Division")).toBe("Commercial");
    expect(jobTypeFromDivision("ACR Warranty Callbacks")).toBe("Warranty");
    expect(jobTypeFromDivision("MISC - Other")).toBe("MISC");
    expect(jobTypeFromDivision("ACR Window Division")).toBe("Windows");
    expect(jobTypeFromDivision(null)).toBe("Unassigned");
    expect(jobTypeFromDivision("Solar Division")).toBe("Solar Division");
  });
});

describe("jpSalesFunnel — the scorecard from CRM results", () => {
  const roof = (over = {}) => ran({ division: "ACR Roofing Division", ...over });
  const rows = [
    roof({ jp_appointment_id: "1", result_option_name: "$ale!!!", crm_job_id: "J1", two_leg_answer: "two_leg" }),
    roof({ jp_appointment_id: "2", result_option_name: "$ale!!!", crm_job_id: "J2", title: "RESET ROOF EST", two_leg_answer: "two_leg" }),
    roof({ jp_appointment_id: "3", result_option_name: "Demo No Sale", two_leg_answer: "one_leg" }),
    roof({ jp_appointment_id: "4", result_option_name: "Demo No Sale", title: "REHASH: Town/1 Main St/Cust" }),
    roof({ jp_appointment_id: "5", result_option_name: "No Demo" }),
    roof({ jp_appointment_id: "6", result_option_name: "No See" }),
    roof({ jp_appointment_id: "7", result_option_name: "Other:" }),
    ran({ jp_appointment_id: "8", division: "ACR Service/Repair Division", result_option_name: "$ale!!!", crm_job_id: "J-missing" }),
    appt({ jp_appointment_id: "9", division: "ACR Roofing Division" }),                          // awaiting result: not in the funnel
    ran({ jp_appointment_id: "10", is_insurance: true, result_option_name: "$ale!!!" }),           // insurance: excluded
    appt({ jp_appointment_id: "11", is_sales_type: false, title: "FINAL WALK THROUGH" }),        // non-sales: excluded
  ];
  const jobs = [
    { jp_job_id: "J1", total_job_price: "16500", total_job_revenue: "16500" },
    { jp_job_id: "J2", total_job_price: null, total_job_revenue: "20799" },
  ];

  it("counts the sheet's columns from CRM results and titles", () => {
    const f = jpSalesFunnel(rows, jobs, "Custom Range", "2026-08-01", "2026-08-31");
    expect(f).toMatchObject({
      attended: 7, newAppts: 5, resetDemo: 1, rehash: 1, noSee: 1,
      demos: 5, noDemo: 1, otherResult: 1, sales: 3, firstCall: 2,
      twoLeg: 2, oneLeg: 1,
      salesAmount: 37299, salesWithAmount: 2, salesMissingAmount: 1,
    });
    expect(f.demoRate).toBe(71);      // 5 / 7
    expect(f.closeRate).toBe(60);     // 3 / 5
    expect(f.noSeeRate).toBe(13);     // 1 / 8
    expect(f.firstCallRate).toBe(67); // 2 / 3
    expect(f.twoLegEligible).toBe(6); // the six roofing appointments run; the repair sale is out
    expect(f.twoLegRate).toBe(33);    // 2 two-leg / 6 retail run (not 2 / 3 answered)
    expect(f.avgSale).toBe(Math.round(37299 / 2));
  });

  it("breaks the same columns down by job type in the sheet's order", () => {
    const f = jpSalesFunnel(rows, jobs, "Custom Range", "2026-08-01", "2026-08-31");
    expect(f.byJobType.map((r) => r.jobType)).toEqual(["Roof Replacement", "Roof Repair"]);
    expect(f.byJobType[0]).toMatchObject({ attended: 6, newAppts: 4, resetDemo: 1, rehash: 1, noSee: 1, demos: 4, sales: 2, salesAmount: 37299 });
    expect(f.byJobType[1]).toMatchObject({ attended: 1, sales: 1, salesMissingAmount: 1, salesAmount: 0, twoLegEligible: 0, twoLegRate: 0 });
  });

  it("can be restricted to one rep's assigned appointments", () => {
    const mixed = [
      roof({ jp_appointment_id: "1", sales_rep: "Jason", result_option_name: "$ale!!!", crm_job_id: "J1" }),
      roof({ jp_appointment_id: "2", sales_rep: "Michael", result_option_name: "Demo No Sale" }),
      roof({ jp_appointment_id: "3", sales_rep: " jason ", result_option_name: "No See" }),
    ];
    const jason = jpSalesFunnel(mixed, jobs, "Custom Range", "2026-08-01", "2026-08-31", "Jason");
    expect(jason).toMatchObject({ attended: 1, sales: 1, noSee: 1, salesAmount: 16500 });
    expect(jpSalesFunnel(mixed, jobs, "Custom Range", "2026-08-01", "2026-08-31").attended).toBe(2);
  });

  it("is empty-safe", () => {
    const f = jpSalesFunnel([], [], "Custom Range", "2026-08-01", "2026-08-31");
    expect(f.attended).toBe(0);
    expect(f.byJobType).toEqual([]);
    expect(f.closeRate).toBe(0);
  });
});

describe("jpDebriefCoverage", () => {
  const jpRows = [
    ran({ jp_appointment_id: "1", crm_lead_id: "1000-1", appointment_date: "2026-08-10" }),
    ran({ jp_appointment_id: "2", crm_lead_id: "1000-2", appointment_date: "2026-08-11" }),
    ran({ jp_appointment_id: "3", crm_lead_id: null }), // can never match
    appt({ jp_appointment_id: "4", is_sales_type: false }), // excluded from the funnel
    ran({ jp_appointment_id: "5", crm_lead_id: "1000-5", result_option_name: "No See" }), // no-show: not expected to be debriefed
    appt({ jp_appointment_id: "6", crm_lead_id: "1000-6" }), // cancelled / no result: not expected either
  ];
  const debriefs = [
    { crm_lead_id: "1000-1", appointment_date: "2026-08-10" },
    { crm_lead_id: "1000-2", appointment_date: "2026-07-01" }, // same lead, different visit
  ];

  it("measures against run appointments and matches on lead id + date", () => {
    const s = jpDebriefCoverage(jpRows, debriefs, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.appointments).toBe(3);
    expect(s.debriefed).toBe(1);
    expect(s.missing).toBe(2);
    expect(s.unmatchable).toBe(1);
    expect(s.coverageRate).toBe(33);
  });

  it("matches lead ids case-insensitively, like the KPI engine does", () => {
    const s = jpDebriefCoverage(
      [ran({ crm_lead_id: "ABC-1", appointment_date: "2026-08-10" })],
      [{ crm_lead_id: "abc-1", appointment_date: "2026-08-10" }],
      "Custom Range", "2026-08-01", "2026-08-31",
    );
    expect(s.debriefed).toBe(1);
  });
});
