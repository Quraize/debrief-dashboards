// Aggregates over the JobProgress mirror tables (jp_appointment, jp_job).
//
// These power the "From JobProgress (CRM)" dashboard sections. They are the
// CRM-side counterpart of kpi.js: kpi.js measures what reps *reported*
// (debriefs); this module measures what the CRM *recorded* (appointments
// booked, result forms, signed contracts). The two deliberately never mix —
// each section labels its own source.
//
// Rows are raw DB rows from the entity API (snake_case). NUMERIC columns
// arrive as strings by design (the backend returns them unparsed to avoid
// float loss), so every money field goes through num().

import { filterByDate } from "./kpi.js";
import { TWO_LEG, ONE_LEG, OTHER } from "./jpResult.js";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }

/** Monday of the week containing dateStr, as YYYY-MM-DD ("" if invalid). */
function weekStart(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

const isSalesType = (r) => r.is_sales_type === true;
const isInsurance = (r) => r.is_insurance === true;

export const JP_SOURCE_NOTE =
  "Pulled directly from the JobProgress CRM by the scheduled sync. Counts every appointment on the calendar — including ones that never received a debrief — so these figures can exceed the debrief-based numbers above.";

export const JP_TWO_LEG_DEFINITION =
  "Two-Leg answers parsed from JobProgress appointment result forms (the free-text \"Was it 2-Legs?\" question). Rate = Two-Leg ÷ (Two-Leg + One-Leg) among retail sales appointments; unanswered forms and insurance records are excluded.";

export const JP_REVENUE_DEFINITION =
  "Sum of each job's JobProgress financial summary (total job revenue), attributed to the month the contract was signed — the CRM-side counterpart of the debrief Sale Amount, which is typed in by the rep.";

export const JP_COVERAGE_DEFINITION =
  "Share of CRM sales-type appointments that have a matching debrief (same Lead ID and appointment date). The gap is appointments nobody debriefed — invisible to every debrief-based number.";

/**
 * Volume and result-form coverage for a period.
 * Result coverage is measured against sales-type appointments only: nobody
 * expects a result form on a warranty visit.
 */
export function jpAppointmentStats(rows, filter, cs, ce) {
  const inRange = filterByDate(rows || [], "appointment_date", filter, cs, ce);
  const sales = inRange.filter(isSalesType);
  const salesWithResult = sales.filter((r) => r.has_result === true).length;

  const weeks = {};
  for (const r of inRange) {
    const w = weekStart(r.appointment_date);
    if (!w) continue;
    weeks[w] = weeks[w] || { week: w, total: 0, salesType: 0 };
    weeks[w].total++;
    if (isSalesType(r)) weeks[w].salesType++;
  }

  return {
    total: inRange.length,
    salesType: sales.length,
    nonSales: inRange.length - sales.length,
    insurance: inRange.filter(isInsurance).length,
    withResult: inRange.filter((r) => r.has_result === true).length,
    resultCoverageRate: pct(salesWithResult, sales.length),
    weekly: Object.values(weeks).sort((a, b) => a.week.localeCompare(b.week)),
  };
}

/**
 * Two-Leg as JobProgress recorded it. Insurance is excluded from both
 * numerator and denominator — the same convention as the retail Two-Leg %
 * in kpi.js, so the two sections are comparable.
 */
export function jpTwoLegStats(rows, filter, cs, ce) {
  const inRange = filterByDate(rows || [], "appointment_date", filter, cs, ce);
  const eligible = inRange.filter((r) => isSalesType(r) && !isInsurance(r));
  const answered = eligible.filter((r) => r.two_leg_answer != null);
  const twoLeg = answered.filter((r) => r.two_leg_answer === TWO_LEG).length;
  const oneLeg = answered.filter((r) => r.two_leg_answer === ONE_LEG).length;
  const other = answered.filter((r) => r.two_leg_answer === OTHER).length;
  return {
    twoLeg, oneLeg, other,
    answered: answered.length,
    eligible: eligible.length,
    rate: pct(twoLeg, twoLeg + oneLeg),
    coverageRate: pct(answered.length, eligible.length),
  };
}

/**
 * Signed-contract revenue, attributed to the signed month. avgJob divides by
 * jobs that actually have financials, so missing summaries surface as a count
 * instead of silently dragging the average down.
 */
export function jpRevenueStats(jobRows, filter, cs, ce) {
  const signed = filterByDate(jobRows || [], "contract_signed_date", filter, cs, ce);
  const withFin = signed.filter((r) => r.total_job_revenue != null && r.total_job_revenue !== "");
  const revenue = withFin.reduce((s, r) => s + num(r.total_job_revenue), 0);

  const byDivision = {};
  const monthly = {};
  for (const r of signed) {
    const d = (r.division && String(r.division).trim()) || "Unassigned";
    byDivision[d] = byDivision[d] || { division: d, jobs: 0, revenue: 0 };
    byDivision[d].jobs++;
    byDivision[d].revenue += num(r.total_job_revenue);
    const m = String(r.contract_signed_date).slice(0, 7);
    monthly[m] = monthly[m] || { month: m, jobs: 0, revenue: 0 };
    monthly[m].jobs++;
    monthly[m].revenue += num(r.total_job_revenue);
  }

  return {
    signedJobs: signed.length,
    withFinancials: withFin.length,
    missingFinancials: signed.length - withFin.length,
    revenue,
    avgJob: withFin.length > 0 ? Math.round(revenue / withFin.length) : 0,
    byDivision: Object.values(byDivision).sort((a, b) => b.revenue - a.revenue),
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
  };
}

function groupBy(rows, field) {
  const map = {};
  for (const r of rows) {
    const key = (r[field] && String(r[field]).trim()) || "Unassigned";
    (map[key] = map[key] || []).push(r);
  }
  return map;
}

/** Per-setter booked volume — the CRM's created_by, not the debrief dropdown. */
export function jpSetterStats(rows, filter, cs, ce) {
  const inRange = filterByDate(rows || [], "appointment_date", filter, cs, ce);
  return Object.entries(groupBy(inRange, "appointment_setter")).map(([name, recs]) => {
    const sales = recs.filter(isSalesType);
    const withResult = recs.filter((r) => r.has_result === true).length;
    return {
      name,
      total: recs.length,
      salesType: sales.length,
      withResult,
      resultCoverageRate: pct(sales.filter((r) => r.has_result === true).length, sales.length),
    };
  }).sort((a, b) => b.total - a.total);
}

/** Per-rep assigned volume with CRM-recorded Two-Leg answers. */
export function jpRepStats(rows, filter, cs, ce) {
  const inRange = filterByDate(rows || [], "appointment_date", filter, cs, ce);
  return Object.entries(groupBy(inRange, "sales_rep")).map(([name, recs]) => {
    const sales = recs.filter(isSalesType);
    const twoLeg = recs.filter((r) => r.two_leg_answer === TWO_LEG).length;
    const oneLeg = recs.filter((r) => r.two_leg_answer === ONE_LEG).length;
    return {
      name,
      total: recs.length,
      salesType: sales.length,
      withResult: recs.filter((r) => r.has_result === true).length,
      twoLeg, oneLeg,
      twoLegRate: pct(twoLeg, twoLeg + oneLeg),
    };
  }).sort((a, b) => b.total - a.total);
}

/**
 * How much of the CRM's sales-type appointment volume the debriefs cover.
 * Matching mirrors computeKPIs: lowercased Lead ID + appointment date, so the
 * same lead debriefed for a different visit does not count.
 */
export function jpDebriefCoverage(jpRows, debriefs, filter, cs, ce) {
  const jpSales = filterByDate(jpRows || [], "appointment_date", filter, cs, ce).filter(isSalesType);
  const keys = new Set();
  for (const d of debriefs || []) {
    if (d.crm_lead_id && d.appointment_date) {
      keys.add(String(d.crm_lead_id).toLowerCase().trim() + "|" + String(d.appointment_date).slice(0, 10));
    }
  }
  let debriefed = 0;
  let unmatchable = 0;
  for (const r of jpSales) {
    if (!r.crm_lead_id) { unmatchable++; continue; }
    const key = String(r.crm_lead_id).toLowerCase().trim() + "|" + String(r.appointment_date).slice(0, 10);
    if (keys.has(key)) debriefed++;
  }
  return {
    jpSalesType: jpSales.length,
    debriefed,
    missing: jpSales.length - debriefed,
    unmatchable,
    coverageRate: pct(debriefed, jpSales.length),
  };
}
