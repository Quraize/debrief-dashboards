import { describe, it, expect } from "vitest";
import {
  effectiveSaleDate, isSale, twoLegStats, isAppointmentOpportunity, repStatsFromDebriefs, appointmentQualityStats,
  appointmentFlow,
} from "../src/kpi.js";

describe("appointmentFlow — the Overview funnel", () => {
  const first = (outcome, over = {}) => ({ appointment_type: "First Appointment", appointment_outcome: outcome, ...over });
  const rows = [
    first("Demo Completed — Sale", { sale_amount: 20000 }),
    first("Demo Completed — Demo No Sale"),
    first("Demo Completed — Demo No Sale", { sale_amount: 14399, sale_signed_date: "2026-09-09" }), // sold later by phone
    first("No Demo — Reset Needed"),
    first("Estimating in Progress — Proposal Not Yet Sent"),     // ran, result not settled
    first("No C / No Show — Reset Needed"),                      // set, did not run
    first("Cancelled Before Appointment"),                       // set, did not run
    first("Rescheduled Before Appointment"),                     // never resolved: not set
    { appointment_type: "Reset Demo", appointment_outcome: "Demo Completed — Demo No Sale" }, // second visit: not a new opportunity
    { appointment_type: "Follow-Up", appointment_outcome: "Demo Completed — Sale", sale_amount: 5000 },
  ];

  it("sums exactly to its parent at every level", () => {
    const f = appointmentFlow(rows);
    expect(f.set).toBe(7);
    expect(f.ran + f.noSee).toBe(f.set);
    expect(f.demo + f.noDemo + f.pending).toBe(f.ran);
    expect(f.sold + f.notSold).toBe(f.demo);
    expect(f).toMatchObject({ set: 7, ran: 5, noSee: 2, demo: 3, noDemo: 1, pending: 1, sold: 2, notSold: 1 });
  });

  it("counts a demo that sold later as sold, and its money, on the appointment's side", () => {
    const f = appointmentFlow(rows);
    expect(f.revenue).toBe(34399);
    expect(f.soldRate).toBe(67);   // 2 of 3 demos
    expect(f.ranRate).toBe(71);    // 5 of 7 set
    expect(f.demoRate).toBe(60);   // 3 of 5 ran
  });

  it("matches the Marketing dashboard's Set and Ran numbers", () => {
    const f = appointmentFlow(rows);
    const aq = appointmentQualityStats(rows);
    expect(f.set).toBe(aq.aqOpportunities + aq.aqNoSee);
    expect(f.ran).toBe(aq.aqOpportunities);
    expect(f.demo).toBe(aq.aqDemos);
  });

  it("is all zeros, not NaN, on an empty range", () => {
    expect(appointmentFlow([])).toMatchObject({ set: 0, ran: 0, sold: 0, revenue: 0, ranRate: 0, soldRate: 0 });
  });
});
import {
  APPOINTMENT_OUTCOMES, DQ_NO_DEMO_OUTCOME, DQ_DEMO_OUTCOME, LEGACY_DQ_OUTCOME,
  DEMO_OUTCOMES, SALE_OUTCOMES, requiresDqReason, dqReasonPrompt,
} from "../src/constants.js";

describe("the two DQ outcomes", () => {
  it("are both offered, and both make the form ask why", () => {
    expect(APPOINTMENT_OUTCOMES).toContain(DQ_NO_DEMO_OUTCOME);
    expect(APPOINTMENT_OUTCOMES).toContain(DQ_DEMO_OUTCOME);
    expect(requiresDqReason(DQ_NO_DEMO_OUTCOME)).toBe(true);
    expect(requiresDqReason(DQ_DEMO_OUTCOME)).toBe(true);
    expect(requiresDqReason("Demo Completed — Sale")).toBe(false);
    expect(requiresDqReason(undefined)).toBe(false);
    // Different question for each: one had a demo, the other did not.
    expect(dqReasonPrompt(DQ_DEMO_OUTCOME).label).toMatch(/after the demo/i);
    expect(dqReasonPrompt(DQ_NO_DEMO_OUTCOME).label).not.toMatch(/after the demo/i);
  });

  it("counts a DQ after a demo as a demo, and a DQ with no demo as an attended no-demo", () => {
    expect(DEMO_OUTCOMES).toContain(DQ_DEMO_OUTCOME);
    expect(SALE_OUTCOMES).not.toContain(DQ_DEMO_OUTCOME);
    expect(isSale({ appointment_outcome: DQ_DEMO_OUTCOME })).toBe(false);
    const aq = appointmentQualityStats([
      { appointment_type: "First Appointment", appointment_outcome: DQ_NO_DEMO_OUTCOME, dq_reason: "Renter, not the homeowner" },
      { appointment_type: "First Appointment", appointment_outcome: "Demo Completed — Sale" },
      { appointment_type: "First Appointment", appointment_outcome: DQ_DEMO_OUTCOME, dq_reason: "Rental, owner out of state" },
      { appointment_type: "First Appointment", appointment_outcome: LEGACY_DQ_OUTCOME }, // retired value: still excluded
    ]);
    expect(aq).toMatchObject({ aqOpportunities: 3, aqAttended: 3, aqDemos: 2, aqNoDemo: 1 });
  });

  it("keeps the retired value out of the dropdown but still understood", () => {
    expect(APPOINTMENT_OUTCOMES).not.toContain(LEGACY_DQ_OUTCOME);
    expect(requiresDqReason(LEGACY_DQ_OUTCOME)).toBe(false);
  });
});

const retail = (over = {}) => ({
  product: "Roofing", appointment_type: "First Appointment",
  appointment_date: "2026-07-15", sales_rep: "Rep A", ...over,
});

describe("effectiveSaleDate — signed-month attribution", () => {
  it("uses the signed date when present, so a July appointment signed in August is an August sale", () => {
    expect(effectiveSaleDate({ appointment_date: "2026-07-15", sale_signed_date: "2026-08-03" }))
      .toBe("2026-08-03");
  });

  it("falls back to the appointment date when the contract date is blank", () => {
    expect(effectiveSaleDate({ appointment_date: "2026-07-15" })).toBe("2026-07-15");
  });

  it("truncates timestamps to a date", () => {
    expect(effectiveSaleDate({ sale_signed_date: "2026-08-03T14:22:00Z" })).toBe("2026-08-03");
  });
});

describe("isSale", () => {
  it("counts a sale by amount, by close type, or by outcome", () => {
    expect(isSale({ sale_amount: 12000 })).toBe(true);
    expect(isSale({ sale_close_type: "First Call Close" })).toBe(true);
    expect(isSale({ appointment_outcome: "Demo Completed — Sale" })).toBe(true);
  });

  it("does not count a demo with no sale", () => {
    expect(isSale({ appointment_outcome: "Demo Completed — Demo No Sale", sale_amount: 0 })).toBe(false);
  });
});

describe("isAppointmentOpportunity", () => {
  it("includes First Appointment, Reset Demo and Rehash", () => {
    for (const t of ["First Appointment", "Reset Demo", "Rehash"]) {
      expect(isAppointmentOpportunity(retail({ appointment_type: t }))).toBe(true);
    }
  });

  it("excludes no-shows, DQ, follow-ups and non-sales records", () => {
    expect(isAppointmentOpportunity(retail({ appointment_outcome: "No C / No Show — Reset Needed" }))).toBe(false);
    expect(isAppointmentOpportunity(retail({ appointment_outcome: "DQ — Disqualified" }))).toBe(false);
    expect(isAppointmentOpportunity(retail({ appointment_type: "Follow-Up" }))).toBe(false);
    expect(isAppointmentOpportunity(retail({ sales_appointment: "No" }))).toBe(false);
  });

  it("accepts legacy type spellings via normalization", () => {
    expect(isAppointmentOpportunity(retail({ appointment_type: "New Appointment" }))).toBe(true);
    expect(isAppointmentOpportunity(retail({ appointment_type: "Re-engagement" }))).toBe(true);
  });
});

describe("twoLegStats", () => {
  it("counts two-leg against eligible retail records only", () => {
    const s = twoLegStats([
      retail({ decision_maker_status: "Two-Leg" }),
      retail({ decision_maker_status: "One-Leg" }),
    ]);
    expect(s.denominator).toBe(2);
    expect(s.twoLeg).toBe(1);
    expect(s.rate).toBe(50);
  });

  it("never lets Insurance into a retail two-leg figure", () => {
    const s = twoLegStats([
      retail({ decision_maker_status: "Two-Leg" }),
      retail({ business_division: "Insurance", trade: "Roofing", decision_maker_status: "Two-Leg" }),
    ]);
    expect(s.denominator).toBe(1);
  });

  it("reports a zero rate rather than dividing by zero", () => {
    expect(twoLegStats([]).rate).toBe(0);
    expect(twoLegStats([]).denominator).toBe(0);
  });
});

describe("split-rep crediting", () => {
  // The invariant: rep-level credit must never inflate the company total.
  const debriefs = [
    retail({ sale_amount: 10000, appointment_outcome: "Demo Completed — Sale" }),
    retail({
      sale_amount: 20000, appointment_outcome: "Demo Completed — Sale",
      sales_rep: "Rep A", secondary_sales_rep: "Rep B",
      primary_rep_split_pct: 60, secondary_rep_split_pct: 40,
    }),
  ];
  const rows = repStatsFromDebriefs(debriefs, "All", "", "");
  const sum = (k) => rows.reduce((t, r) => t + r[k], 0);

  it("credited revenue sums to the full company revenue, not more", () => {
    expect(sum("creditedRevenue")).toBe(30000);
  });

  it("credited sales sum to the distinct sale count", () => {
    expect(sum("creditedSales")).toBeCloseTo(2, 10);
  });

  it("splits the shared job by percentage", () => {
    const a = rows.find((r) => r.name === "Rep A");
    const b = rows.find((r) => r.name === "Rep B");
    expect(a.creditedRevenue).toBe(10000 + 12000);
    expect(b.creditedRevenue).toBe(8000);
    expect(b.jobsParticipated).toBe(1);
  });

  it("gives a solo rep the whole sale", () => {
    const solo = repStatsFromDebriefs(
      [retail({ sale_amount: 5000, appointment_outcome: "Demo Completed — Sale" })], "All", "", "");
    expect(solo[0].creditedRevenue).toBe(5000);
    expect(solo[0].creditedSales).toBe(1);
  });
});
