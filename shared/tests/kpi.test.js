import { describe, it, expect } from "vitest";
import {
  effectiveSaleDate, isSale, twoLegStats, isAppointmentOpportunity, repStatsFromDebriefs,
} from "../src/kpi.js";

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
