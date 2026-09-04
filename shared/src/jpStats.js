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

/** The CRM result that means "the rep went, the customer did not show". */
const NO_SHOW_RESULT = /no\s*see|no\s*show|cancel/i;
export const isNoShowResult = (r) => NO_SHOW_RESULT.test(String(r.result_option_name ?? ""));

/**
 * An appointment that was actually RUN: a sales opportunity where the rep met
 * the customer and a result was recorded. This is the headline "Appointments"
 * figure, agreed with the office against July 2026 (98 on the calendar → 62
 * run). Everything it excludes is reported alongside it, never hidden:
 *   non-sales visits, no-shows ("No See"), and sales-type appointments with no
 *   result form (cancellations still on the calendar, forms never filled in).
 */
export const isRunAppointment = (r) => isSalesType(r) && r.has_result === true && !isNoShowResult(r);

/** The office marks a cancelled appointment by prefixing its title. */
export const isCancelledTitle = (r) => /cancel/i.test(String(r.title ?? ""));

/**
 * A held appointment whose result has not been recorded yet is "awaiting
 * result" for this many days — reps fill the CRM form after the fact, not on
 * the day. Beyond it, a missing result is treated as never coming.
 */
export const AWAITING_RESULT_DAYS = 14;

/** YYYY-MM-DD of `now` in the viewer's local time (dashboards run on office clocks). */
function localDay(now) {
  const d = now instanceof Date ? now : new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Where a sales-type appointment WITHOUT a result belongs:
 *   "cancelled"  — title says so (any age)
 *   "upcoming"   — today or later: nothing to record yet
 *   "awaiting"   — held within the last AWAITING_RESULT_DAYS, form not filled yet
 *   "no_result"  — older than that: the result is not coming
 */
export function classifyNoResult(r, now = new Date()) {
  if (isCancelledTitle(r)) return "cancelled";
  const today = localDay(now);
  const date = String(r.appointment_date ?? "").slice(0, 10);
  if (!date || date >= today) return "upcoming";
  const ageDays = (Date.parse(`${today}T00:00:00`) - Date.parse(`${date}T00:00:00`)) / 86_400_000;
  return ageDays <= AWAITING_RESULT_DAYS ? "awaiting" : "no_result";
}

export const JP_SOURCE_NOTE =
  "Pulled directly from the JobProgress CRM by the scheduled sync. Counts what the CRM recorded — including appointments that never received a debrief — so these figures can differ from the debrief-based numbers above.";

export const JP_APPOINTMENTS_DEFINITION =
  "Appointments = sales-type CRM appointments that were actually run: the rep met the customer and a result was recorded (Sale, Demo No Sale, No Demo…). Non-sales visits, no-shows (\"No See\"), appointments still awaiting their result, upcoming ones, and cancelled / no-result ones are excluded and shown on their own cards.";

export const JP_AWAITING_DEFINITION =
  `Sales appointments held in the last ${AWAITING_RESULT_DAYS} days whose result form has not been filled in JobProgress yet. They move into Appointments (or No-Shows) as soon as the rep records the result — so early in a month, Appointments lags by however long that takes.`;

export const JP_TWO_LEG_DEFINITION =
  "Two-Leg answers parsed from JobProgress appointment result forms (the free-text \"Was it 2-Legs?\" question). Rate = Two-Leg ÷ (Two-Leg + One-Leg) among retail sales appointments; unanswered forms and insurance records are excluded.";

export const JP_REVENUE_DEFINITION =
  "Sum of each job's JobProgress financial summary (total job revenue), attributed to the month the contract was signed — the CRM-side counterpart of the debrief Sale Amount, which is typed in by the rep.";

export const JP_COVERAGE_DEFINITION =
  "Share of CRM appointments actually run (see Appointments) that have a matching debrief (same Lead ID and appointment date). The gap is run appointments nobody debriefed — invisible to every debrief-based number.";

/**
 * Volume for a period: what was on the calendar, and how it splits into run
 * appointments, no-shows, no-result and non-sales visits (the four always add
 * back up to the calendar total).
 * Result coverage is measured against sales-type appointments only: nobody
 * expects a result form on a warranty visit.
 */
export function jpAppointmentStats(rows, filter, cs, ce, now = new Date()) {
  const inRange = filterByDate(rows || [], "appointment_date", filter, cs, ce);
  const sales = inRange.filter(isSalesType);
  const salesWithResult = sales.filter((r) => r.has_result === true);
  const run = sales.filter(isRunAppointment);
  const noShows = salesWithResult.filter(isNoShowResult);

  // Sales-type appointments with no result yet, split by what the silence means.
  const pending = { cancelled: 0, upcoming: 0, awaiting: 0, no_result: 0 };
  for (const r of sales) {
    if (r.has_result !== true) pending[classifyNoResult(r, now)]++;
  }

  const weeks = {};
  for (const r of inRange) {
    const w = weekStart(r.appointment_date);
    if (!w) continue;
    weeks[w] = weeks[w] || { week: w, total: 0, salesType: 0, run: 0 };
    weeks[w].total++;
    if (isSalesType(r)) weeks[w].salesType++;
    if (isRunAppointment(r)) weeks[w].run++;
  }

  return {
    total: inRange.length,
    /** The headline: appointments actually run. */
    run: run.length,
    salesType: sales.length,
    nonSales: inRange.length - sales.length,
    noShows: noShows.length,
    /** Held recently, result form not filled yet — will move into `run` (or no-shows) once it is. */
    awaitingResult: pending.awaiting,
    /** Today or later: nothing to record yet. */
    upcoming: pending.upcoming,
    /** Cancelled by title, or held so long ago the result is not coming. */
    noResult: pending.cancelled + pending.no_result,
    insurance: inRange.filter(isInsurance).length,
    withResult: inRange.filter((r) => r.has_result === true).length,
    resultCoverageRate: pct(salesWithResult.length, sales.length),
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
      run: recs.filter(isRunAppointment).length,
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
      run: recs.filter(isRunAppointment).length,
      salesType: sales.length,
      withResult: recs.filter((r) => r.has_result === true).length,
      twoLeg, oneLeg,
      twoLegRate: pct(twoLeg, twoLeg + oneLeg),
    };
  }).sort((a, b) => b.total - a.total);
}

/**
 * How much of the CRM's RUN appointment volume the debriefs cover — the same
 * population as the Appointments card, so no-shows and cancellations nobody
 * debriefed do not drag the figure down.
 * Matching mirrors computeKPIs: lowercased Lead ID + appointment date, so the
 * same lead debriefed for a different visit does not count.
 */
export function jpDebriefCoverage(jpRows, debriefs, filter, cs, ce) {
  const jpSales = filterByDate(jpRows || [], "appointment_date", filter, cs, ce).filter(isRunAppointment);
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
    appointments: jpSales.length,
    /** @deprecated same as `appointments`; kept for older callers. */
    jpSalesType: jpSales.length,
    debriefed,
    missing: jpSales.length - debriefed,
    unmatchable,
    coverageRate: pct(debriefed, jpSales.length),
  };
}
