// Call-center (appointment setter) metrics from the CRM mirror.
//
// Two independent CRM records of who set an appointment:
//   appointment.created_by  → jp_appointment.appointment_setter (who booked it)
//   customer.call_center_rep → jp_customer.call_center_rep (who owns the lead)
// The first gives set / show / demo / sale outcomes per setter; the second
// gives leads assigned, so a set rate (appointments ÷ leads) is possible.
//
// Attribution windows match the debrief-side Call Center dashboard: outcomes
// by APPOINTMENT date. "Booked this period" (by booking date) is reported
// separately for managers who run the room by bookings.
//
// SER = sales $ ÷ demos ÷ 100 — the dashboard's own standard (≥135 excellent,
// 120–134 good). Two-Leg bands: ≥90 excellent, 80–89 good.

import { filterByDate } from "./kpi.js";
import {
  isRunAppointment, isNoShowResult, isDemoResult, isSaleResult, isResetTitle, classifyNoResult,
} from "./jpStats.js";
import { TWO_LEG, ONE_LEG } from "./jpResult.js";

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
export const REP_SELF_BOOKED = "Reps (self-booked)";
export const UNKNOWN_SETTER = "Nobody recorded";

/** Name key tolerant of the CRM's double spaces and case ("Ashley  Pascual"). */
export const nameKey = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const display = (s) => String(s ?? "").trim().replace(/\s+/g, " ");

export const JP_CALL_CENTER_DEFINITIONS = {
  leadsAssigned: "CRM customers created in this period with a Call Center Rep set on the customer record — the leads the caller owns.",
  leadsUnassigned: "CRM customers created in this period with NO Call Center Rep — nobody in the call center is credited for them.",
  set: "Sales appointments dated in this period, by whoever created them in JobProgress (no-shows and cancellations included — they were still set).",
  setRate: "Appointments set ÷ leads assigned in the same period. Rough: an appointment can belong to a lead assigned earlier.",
  bookedThisPeriod: "Sales appointments CREATED in this period (booking date), whatever date they are for.",
  run: "Appointments actually run: result recorded, not a no-show.",
  noSee: "Result \"No See\": the customer did not show.",
  showRate: "Run ÷ (run + no-shows).",
  demos: "Result $ale!!! or Demo No Sale.",
  demoRate: "Demos ÷ appointments run.",
  twoLegRate: "Two-Leg ÷ (Two-Leg + One-Leg) on answered result forms.",
  sales: "Result $ale!!!.",
  salesAmount: "Contract value of the sold jobs (JobProgress financials), appointment month.",
  ser: "Sales $ ÷ demos ÷ 100 — the Call Center dashboard's Setter Efficiency Ratio.",
  resets: "Run appointments titled RESET — rebooked after a no-demo or no-show.",
  pending: "Set appointments with no result yet (awaiting result, upcoming, or cancelled).",
};

function bucket(label) {
  return { label, isReps: false, leadsAssigned: 0, set: 0, run: 0, noSee: 0, demos: 0, sales: 0,
    salesAmount: 0, salesMissingAmount: 0, twoLeg: 0, oneLeg: 0, resets: 0, pending: 0, cancelled: 0 };
}
function finish(b) {
  const ser = b.demos > 0 ? Math.round(b.salesAmount / b.demos / 100) : 0;
  const twoLegRate = pct(b.twoLeg, b.twoLeg + b.oneLeg);
  return {
    ...b,
    setRate: pct(b.set, b.leadsAssigned),
    showRate: pct(b.run, b.run + b.noSee),
    noSeeRate: pct(b.noSee, b.run + b.noSee),
    demoRate: pct(b.demos, b.run),
    closeRate: pct(b.sales, b.demos),
    twoLegRate,
    twoLegRating: b.twoLeg + b.oneLeg === 0 ? "No Data" : twoLegRate >= 90 ? "Excellent" : twoLegRate >= 80 ? "Good" : "Poor",
    ser,
    serRating: b.demos === 0 ? "No Data" : ser >= 135 ? "Excellent" : ser >= 120 ? "Good" : "Poor",
  };
}
function jobAmount(job) {
  if (!job) return null;
  for (const k of ["total_job_price", "total_job_revenue", "final_job_total"]) {
    const n = Number(job[k]);
    if (job[k] != null && job[k] !== "" && Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/**
 * @param appointments jp_appointment rows
 * @param customers    jp_customer rows (may be empty until the customer sync has run)
 * @param jobs         jp_job rows
 */
export function jpCallCenterStats(appointments, customers, jobs, filter, cs, ce, now = new Date()) {
  const jobById = new Map();
  for (const j of jobs || []) if (j.jp_job_id != null) jobById.set(String(j.jp_job_id), j);

  const total = bucket("Team");
  const bySetter = new Map();
  const get = (raw, isReps = false) => {
    const key = isReps ? REP_SELF_BOOKED : (nameKey(raw) || UNKNOWN_SETTER);
    if (!bySetter.has(key)) { const b = bucket(isReps ? REP_SELF_BOOKED : (display(raw) || UNKNOWN_SETTER)); b.isReps = isReps; bySetter.set(key, b); }
    return bySetter.get(key);
  };

  // Leads assigned, by the customer's call-center rep (customer creation date).
  let leadsUnassigned = 0;
  const leadRows = (customers || [])
    .map((c) => ({ ...c, lead_date: String(c.jp_created_at ?? "").slice(0, 10) }))
    .filter((c) => c.lead_date);
  for (const c of filterByDate(leadRows, "lead_date", filter, cs, ce)) {
    if (!nameKey(c.call_center_rep)) { leadsUnassigned++; continue; }
    total.leadsAssigned++;
    get(c.call_center_rep).leadsAssigned++;
  }

  // Outcomes, by appointment date and by who created the appointment.
  const inRange = filterByDate(appointments || [], "appointment_date", filter, cs, ce)
    .filter((r) => r.is_sales_type === true && r.is_insurance !== true);
  for (const r of inRange) {
    const selfBooked = !!nameKey(r.appointment_setter) && nameKey(r.appointment_setter) === nameKey(r.sales_rep);
    const bs = [total, get(r.appointment_setter, selfBooked)];
    for (const b of bs) b.set++;
    if (r.has_result === true && isNoShowResult(r)) { for (const b of bs) b.noSee++; continue; }
    if (!isRunAppointment(r)) {
      const why = r.has_result === true ? "other" : classifyNoResult(r, now);
      for (const b of bs) { b.pending++; if (why === "cancelled") b.cancelled++; }
      continue;
    }
    const sale = isSaleResult(r);
    const amount = sale ? jobAmount(r.crm_job_id != null ? jobById.get(String(r.crm_job_id)) : null) : null;
    for (const b of bs) {
      b.run++;
      if (isDemoResult(r)) b.demos++;
      if (isResetTitle(r)) b.resets++;
      if (sale) { b.sales++; if (amount != null) b.salesAmount += amount; else b.salesMissingAmount++; }
      if (r.two_leg_answer === TWO_LEG) b.twoLeg++;
      else if (r.two_leg_answer === ONE_LEG) b.oneLeg++;
    }
  }

  // Booked in the period (by CRM creation date), regardless of appointment date.
  const bookedRows = (appointments || [])
    .filter((r) => r.is_sales_type === true && r.is_insurance !== true)
    .map((r) => ({ ...r, booked_date: String(r.jp_created_at ?? "").slice(0, 10) }))
    .filter((r) => r.booked_date);
  const bookedThisPeriod = filterByDate(bookedRows, "booked_date", filter, cs, ce).length;

  const rows = [...bySetter.values()].map(finish).sort((a, b) =>
    (a.isReps ? 1 : 0) - (b.isReps ? 1 : 0) || b.set - a.set || b.leadsAssigned - a.leadsAssigned || a.label.localeCompare(b.label));

  return { ...finish(total), bySetter: rows, leadsUnassigned, bookedThisPeriod, hasLeadData: (customers || []).length > 0 };
}
