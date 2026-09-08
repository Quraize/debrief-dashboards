import { describe, it, expect } from "vitest";
import { compareDebriefToCrm, debriefCrmSummary, sameRep, amountsDiffer, HARD_DISCREPANCIES } from "../src/debriefCrm.js";
import { indexJpAppointments, indexById } from "../src/debriefQueue.js";

const NOW = new Date("2026-09-08T10:00:00");

const jp = (over = {}) => ({
  jp_appointment_id: "1", crm_lead_id: "J-100", crm_job_id: "7001", jp_customer_id: "9001", appointment_date: "2026-09-03",
  title: "ROOF EST: Town/1 Main/Cust", is_sales_type: true, is_insurance: false, has_result: true,
  result_option_name: "$ale!!!", two_leg_answer: "two_leg", two_leg_raw: "2 legs", division: "ACR Roofing Division",
  sales_rep: "Jason Malarchak", appointment_setter: "Ashley Pascual", jp_created_at: "2026-08-20T13:00:00.000Z", ...over,
});
const debrief = (over = {}) => ({
  id: "d1", crm_lead_id: "j-100", crm_job_id: null, appointment_date: "2026-09-03", appointment_outcome: "Demo Completed — Sale",
  sale_amount: "27000", decision_maker_status: "Two-Leg", sales_rep: "Jason", ...over,
});
const ctx = (jpRows, jobs = [{ jp_job_id: "7001", total_job_price: "27000" }]) => ({
  jpByKey: indexJpAppointments(jpRows),
  customersById: indexById([{ jp_customer_id: "9001", referred_by_name: "Google Ads" }], "jp_customer_id"),
  jobsById: indexById(jobs, "jp_job_id"),
});
const codes = (r) => r.discrepancies.map((d) => d.code);

describe("sameRep / amountsDiffer", () => {
  it("treats a first name as the same person as the full name", () => {
    expect(sameRep("Jason", "Jason Malarchak")).toBe(true);
    expect(sameRep("jason  malarchak", "Jason Malarchak")).toBe(true);
    expect(sameRep("Pema", "Jason Malarchak")).toBe(false);
    expect(sameRep("", "Jason")).toBe(true);
  });
  it("tolerates the larger of $500 or 5%", () => {
    expect(amountsDiffer(27000, 27400)).toBe(false);
    expect(amountsDiffer(27000, 28600)).toBe(true);
    expect(amountsDiffer(5000, 5450)).toBe(false);
    expect(amountsDiffer(5000, 5600)).toBe(true);
    expect(amountsDiffer(0, 5600)).toBe(false);
  });
});

describe("compareDebriefToCrm", () => {
  it("is 'ok' when the debrief and the CRM agree", () => {
    const r = compareDebriefToCrm(debrief(), ctx([jp()]), NOW);
    expect(r.matched).toBe(true);
    expect(r.severity).toBe("ok");
    expect(r.discrepancies).toEqual([]);
    expect(r.crm.result).toBe("$ale!!!");
    expect(r.lead.source).toBe("Google Ads");
    expect(r.job.price).toBe(27000);
  });

  it("is 'unmatched' when the CRM mirror has no appointment for the Lead ID + date", () => {
    const r = compareDebriefToCrm(debrief({ crm_lead_id: "J-999" }), ctx([jp()]), NOW);
    expect(r).toMatchObject({ matched: false, severity: "unmatched", crm: null, discrepancies: [] });
  });

  it("flags a sale on one side only", () => {
    const a = compareDebriefToCrm(debrief({ appointment_outcome: "Demo Completed — Demo No Sale", sale_amount: null }), ctx([jp()]), NOW);
    expect(codes(a)).toEqual(["outcome_sale"]);
    expect(a.severity).toBe("mismatch");
    const b = compareDebriefToCrm(debrief(), ctx([jp({ result_option_name: "Demo No Sale" })]), NOW);
    expect(codes(b)).toEqual(["outcome_sale"]);
  });

  it("flags demo vs no-demo, No See, and cancelled disagreements", () => {
    const noDemoCrm = ctx([jp({ result_option_name: "No Demo" })]);
    expect(codes(compareDebriefToCrm(debrief({ appointment_outcome: "Demo Completed — Demo No Sale", sale_amount: null }), noDemoCrm, NOW))).toEqual(["outcome_demo"]);
    expect(codes(compareDebriefToCrm(debrief({ appointment_outcome: "No Demo — Reset Needed", sale_amount: null }), noDemoCrm, NOW))).toEqual([]);

    const noSeeCrm = ctx([jp({ result_option_name: "No See" })]);
    expect(codes(compareDebriefToCrm(debrief({ appointment_outcome: "Demo Completed — Demo No Sale", sale_amount: null }), noSeeCrm, NOW))).toEqual(["outcome_no_see"]);
    expect(codes(compareDebriefToCrm(debrief({ appointment_outcome: "No C / No Show — Reset Needed", sale_amount: null }), noSeeCrm, NOW))).toEqual([]);

    const cancelled = ctx([jp({ has_result: false, result_option_name: null, title: "CANCELLED ROOF EST" })]);
    expect(codes(compareDebriefToCrm(debrief(), cancelled, NOW))).toEqual(["outcome_cancelled"]);
    expect(codes(compareDebriefToCrm(debrief({ appointment_outcome: "Cancelled Before Appointment", sale_amount: null }), cancelled, NOW))).toEqual([]);
  });

  it("reports a missing CRM result form as attention, not a mismatch", () => {
    const r = compareDebriefToCrm(debrief(), ctx([jp({ has_result: false, result_option_name: null, two_leg_answer: null })]), NOW);
    expect(codes(r)).toEqual(["crm_no_result"]);
    expect(r.severity).toBe("info");
  });

  it("flags contract value and Two-Leg differences", () => {
    const r = compareDebriefToCrm(debrief({ sale_amount: "31000", decision_maker_status: "One-Leg" }), ctx([jp()]), NOW);
    expect(codes(r)).toEqual(["amount", "two_leg"]);
    expect(r.discrepancies[0]).toMatchObject({ debrief: "$31,000", crm: "$27,000" });
    expect(r.discrepancies[1]).toMatchObject({ debrief: "One-Leg", crm: 'Two-Leg ("2 legs")' });
    // Unknown CRM value, or no debrief answer → nothing to compare.
    expect(codes(compareDebriefToCrm(debrief({ decision_maker_status: "N/A" }), ctx([jp()]), NOW))).toEqual([]);
    expect(codes(compareDebriefToCrm(debrief(), ctx([jp({ two_leg_answer: "other" })]), NOW))).toEqual([]);
  });

  it("flags a different rep as attention only", () => {
    const r = compareDebriefToCrm(debrief({ sales_rep: "Pema Sherpa" }), ctx([jp()]), NOW);
    expect(codes(r)).toEqual(["rep"]);
    expect(r.severity).toBe("info");
    expect(HARD_DISCREPANCIES.has("rep")).toBe(false);
  });
});

describe("debriefCrmSummary", () => {
  it("counts severities and compares revenue for the same debriefs", () => {
    const c = ctx([jp(), jp({ jp_appointment_id: "2", crm_lead_id: "J-200", crm_job_id: "7002" })],
      [{ jp_job_id: "7001", total_job_price: "27000" }]); // 7002 has no financials
    const rows = [
      debrief(),
      debrief({ id: "d2", crm_lead_id: "J-200", sale_amount: "19000" }),
      debrief({ id: "d3", crm_lead_id: "J-999", sale_amount: "5000" }),
    ].map((d) => ({ debrief: d, cmp: compareDebriefToCrm(d, c, NOW) }));
    expect(debriefCrmSummary(rows)).toEqual({
      total: 3, matched: 2, ok: 2, info: 0, mismatch: 0, unmatched: 1,
      crmSales: 2, crmRevenue: 27000, crmSalesMissingAmount: 1, debriefRevenue: 51000,
    });
  });
});
