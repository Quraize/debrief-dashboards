import {
  DEMO_OUTCOMES, SALE_OUTCOMES, NON_COMPLETED_OUTCOMES, RESET_OUTCOMES,
  DEMO_NO_SALE_OUTCOME, SALE_CREDIT_DECLINE_OUTCOME, SALE_CANCELLATION_OUTCOME,
  FIRST_CALL_CLOSE, CREDIT_DECLINE_CLOSE, CANCELLATION_CLOSE, inDateRange
} from "./constants.js";
import { salesAppointmentsOnly } from "./salesAppointment.js";
import { nonInsuranceDebriefs, nonInsuranceAppointments } from "./insurance.js";
import { getMarketingCategory } from "./marketingSources.js";
import { normalizeAppointmentType, APPT_TYPE_FIRST, APPT_TYPE_RESET_DEMO, APPT_TYPE_REHASH } from "./appointmentTypes.js";
import { classifyAppointment } from "./appointmentClassification.js";

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
export function safeNum(v) { return num(v); }
function pct(a, b) { const na = num(a); return b > 0 ? Math.round((na / b) * 100) : 0; }
function ratePct(val, excellent, good) { if (val === 0) return null; return val >= excellent ? "green" : val >= good ? "yellow" : "red"; }

const SALE_CLOSE_ACTUAL = ["First Call Close", "Rehash Close", "Follow-Up Close", "Reset Close", "Sale After Follow-Up"];

// Eligible retail products for the Two-Leg denominator.
export const TWO_LEG_DIVISIONS = ["Roofing", "Siding", "Roofing + Siding"];
// Canonical appointment-type eligibility is handled by normalizeAppointmentType (see appointmentTypes.js).
// Legacy variant arrays (New Appointment, Re-engagement, etc.) are no longer used — normalization
// at the KPI boundary maps all spellings to First Appointment / Rehash before any comparison.

export const TWO_LEG_DEFINITION =
  "Two-Leg % = Two-Leg appointments ÷ (First Appointments + Reset Demos + Rehashes) for the Roofing, Siding, and Roofing + Siding divisions only. " +
  "Commercial, Repairs, Misc, Insurance, Unclassified, and non-sales appointments (Warranty Callback, Sample, Walk Thru, Customer Service) " +
  "are excluded from both numerator and denominator. " +
  "Classification uses the shared classifier: raw JobProgress Division first, then appointment title fallback.";

/**
 * A single debrief is eligible for the Two-Leg denominator when:
 *  - it is NOT an Insurance record (business_division/product), even if the trade is Roofing/Siding;
 *  - it is a sales appointment (sales_appointment !== "No");
 *  - its product is Roofing, Siding, or Roofing + Siding;
 *  - its appointment type normalizes to First Appointment, Reset Demo, or Rehash.
 * This helper is the single source of truth — every dashboard/rep/setter/export path calls it
 * (directly or via twoLegStats), so Insurance can never sneak into a retail Two-Leg figure.
 */
// No C / No Show / Cancelled Before Appointment outcomes — excluded from Appointment Opportunities.
const NO_C_NO_SHOW_OUTCOMES = ["No C / No Show — Reset Needed", "No C / No Show — Do Not Reset", "Cancelled Before Appointment"];

/**
 * Appointment Opportunities = records whose appointment type is First Appointment,
 * Reset Demo, or Rehash, excluding No C/No Show/Cancelled Before Appointment outcomes,
 * Follow-Ups, DQ, and non-sales appointments.
 * This is the sole population used for the Appointments KPI and the Two-Leg % denominator base.
 */
export function isAppointmentOpportunity(d) {
  if (!d) return false;
  if (d.sales_appointment === "No") return false;
  const t = normalizeAppointmentType(d.appointment_type);
  if (t !== APPT_TYPE_FIRST && t !== APPT_TYPE_RESET_DEMO && t !== APPT_TYPE_REHASH) return false;
  if (NO_C_NO_SHOW_OUTCOMES.includes(d.appointment_outcome)) return false;
  if (d.appointment_outcome === "DQ — Disqualified") return false;
  return true;
}

export const APPOINTMENT_OPPORTUNITIES_DEFINITION =
  "Appointment Opportunities = First Appointments + Reset Demos + Rehashes, excluding No C/No Show/Cancelled Before Appointment outcomes, Follow-Ups, DQ, and non-sales appointments.";

/**
 * A single debrief is eligible for the Two-Leg denominator when:
 *  - it is an Appointment Opportunity (First Appt/Reset Demo/Rehash, not No C/No Show, not DQ, not non-sales);
 *  - it is NOT an Insurance record;
 *  - its reporting division is Roofing, Siding, or Roofing + Siding.
 * Uses the record's actual Decision Maker Status — never infers status from setter or sales result.
 */
export function isTwoLegEligible(d) {
  if (!d) return false;
  if (!isAppointmentOpportunity(d)) return false;
  const c = classifyAppointment(d);
  return c.two_leg_eligible;
}

// Canonical Two-Leg helper: numerator = Two-Leg among eligible records (see isTwoLegEligible).
// Insurance is excluded inside the helper itself so callers cannot accidentally include it.
export function twoLegStats(debriefs) {
  const all = debriefs || [];
  const denomRecords = all.filter(isTwoLegEligible);
  const denominator = denomRecords.length;
  const twoLeg = denomRecords.filter((d) => d.decision_maker_status === "Two-Leg").length;
  const oneLeg = denomRecords.filter((d) => d.decision_maker_status === "One-Leg").length;
  const missingAnswer = denomRecords.filter((d) => !d.decision_maker_status).length;
  const naNeedsReview = denomRecords.filter((d) => typeof d.decision_maker_status === "string" && d.decision_maker_status.trim().toUpperCase() === "N/A").length;
  const firstAppts = denomRecords.filter((d) => normalizeAppointmentType(d.appointment_type) === APPT_TYPE_FIRST).length;
  const resetDemos = denomRecords.filter((d) => normalizeAppointmentType(d.appointment_type) === APPT_TYPE_RESET_DEMO).length;
  const rehashes = denomRecords.filter((d) => normalizeAppointmentType(d.appointment_type) === APPT_TYPE_REHASH).length;
  const excludedNoCNoShow = all.filter((d) => {
    const t = normalizeAppointmentType(d.appointment_type);
    return (t === APPT_TYPE_FIRST || t === APPT_TYPE_RESET_DEMO || t === APPT_TYPE_REHASH) &&
           NO_C_NO_SHOW_OUTCOMES.includes(d.appointment_outcome);
  }).length;
  const na = all.length - denominator;
  return { twoLeg, denominator, oneLeg, missingAnswer, naNeedsReview, na, firstAppts, resetDemos, rehashes, excludedNoCNoShow, rate: denominator > 0 ? Math.round((twoLeg / denominator) * 100) : 0 };
}

export function isSale(d) {
  return num(d.sale_amount) > 0 ||
    SALE_CLOSE_ACTUAL.includes(d.sale_close_type) ||
    SALE_OUTCOMES.includes(d.appointment_outcome);
}

// ── Canonical appointment-quality metrics (Demo Rate, No-Demo, No C/No Show, Reset) ──
export const AQ_FOLLOW_UP = ["Follow-Up", "Follow Up", "Followup"];
const AQ_NO_SEE_OUTCOMES = ["No Show", "No C / No Show — Reset Needed", "No C / No Show — Do Not Reset", "Cancelled Before Appointment"];
const AQ_NO_SEE_TYPES = ["No Show"];
const AQ_NO_SEE_STATUSES = ["Cancelled", "Canceled"];
const AQ_CORE_EXCLUDE_OUTCOMES = ["Rescheduled Before Appointment", "Pending / Not Updated"];
const AQ_NO_DEMO_OUTCOMES = ["No Demo / Not Presented", "No Demo — Reset Needed", "No Demo — Do Not Reset"];
const AQ_DQ_OUTCOME = "DQ — Disqualified";

export const DEMO_RATE_DEFINITION = "Demos completed on First Appointments and Rehashes ÷ eligible First Appointments and Rehashes. Reset Demos and Follow-Ups are excluded.";
export const NO_DEMO_RATE_DEFINITION = "Attended eligible appointments that did not demo ÷ attended eligible appointments (Demo + No Demo). No See records are excluded.";
export const NO_SEE_RATE_DEFINITION = "No See (No Show + Cancelled Appointment) ÷ eligible scheduled First Appointment and Rehash opportunities, including the No See records. Reset Demos, Follow-Ups, DQ, and non-sales appointments are excluded.";
export const RESET_RATE_DEFINITION = "Original eligible appointments requiring a reset ÷ eligible First Appointment and Rehash opportunities.";
export const RESET_RECOVERY_DEFINITION = "Completed Reset Demos ÷ reset-needed opportunities.";
export const LEGACY_DEMO_RATE_DEFINITION = "All Demos ÷ (First Appointments + Rehash + Reset Demos). Legacy comparison only — not the headline Demo Rate.";

export function isNoSeeRecord(d) {
  return AQ_NO_SEE_OUTCOMES.includes(d.appointment_outcome) || AQ_NO_SEE_TYPES.includes(d.appointment_type) || AQ_NO_SEE_STATUSES.includes(d.appointment_status);
}
function aqCoreExcluded(d) {
  return d.appointment_outcome === AQ_DQ_OUTCOME || AQ_CORE_EXCLUDE_OUTCOMES.includes(d.appointment_outcome) || d.sales_appointment === "No";
}
function aqEligibleType(d) {
  if (!d.appointment_type) return false;
  const t = normalizeAppointmentType(d.appointment_type);
  return t === APPT_TYPE_FIRST || t === APPT_TYPE_REHASH;
}
function aqIsDemo(d) { return DEMO_OUTCOMES.includes(d.appointment_outcome); }
function aqIsNoDemo(d) { return AQ_NO_DEMO_OUTCOMES.includes(d.appointment_outcome); }
function aqAttended(d) { return aqIsDemo(d) || aqIsNoDemo(d); }
function aqResetNeeded(d) { return d.reset_needed === true || RESET_OUTCOMES.includes(d.appointment_outcome); }
function aqCompletedResetDemo(d) { return normalizeAppointmentType(d.appointment_type) === APPT_TYPE_RESET_DEMO && aqAttended(d) && !aqCoreExcluded(d); }

export function appointmentQualityStats(debriefs) {
  const ds = debriefs || [];
  // Demo Rate eligible = First Appt + Rehash, not core-excluded, not No See (attended only)
  const demoRateEligible = ds.filter((d) => aqEligibleType(d) && !aqCoreExcluded(d) && !isNoSeeRecord(d));
  const opportunities = demoRateEligible.length;
  const attended = demoRateEligible.filter(aqAttended).length;
  const demos = demoRateEligible.filter(aqIsDemo).length;
  const noDemos = demoRateEligible.filter(aqIsNoDemo).length;
  // No See = No Show + Cancelled Appointment (not core-excluded)
  const noSeeRecords = ds.filter((d) => isNoSeeRecord(d) && !aqCoreExcluded(d));
  const noSee = noSeeRecords.length;
  const noSeeDenom = opportunities + noSee;
  const resetNeeded = demoRateEligible.filter(aqResetNeeded).length;
  const completedResetDemos = ds.filter(aqCompletedResetDemo).length;
  const legacyPool = ds.filter((d) => {
    if (!d.appointment_type) return false;
    const t = normalizeAppointmentType(d.appointment_type);
    return (t === APPT_TYPE_FIRST || t === APPT_TYPE_REHASH || t === APPT_TYPE_RESET_DEMO) && !aqCoreExcluded(d) && !isNoSeeRecord(d);
  });
  const legacyDemos = legacyPool.filter(aqIsDemo).length;
  return {
    aqDemos: demos, aqOpportunities: opportunities, aqAttended: attended,
    aqNoDemo: noDemos, aqNoSee: noSee, aqNoSeeDenom: noSeeDenom,
    aqResetNeeded: resetNeeded, aqCompletedResetDemo: completedResetDemos,
    aqLegacyDemos: legacyDemos, aqLegacyDenom: legacyPool.length,
    demoRate: pct(demos, opportunities),
    noDemoRate: pct(noDemos, attended),
    noSeeRate: pct(noSee, noSeeDenom),
    resetRate: pct(resetNeeded, opportunities),
    resetRecoveryRate: pct(completedResetDemos, resetNeeded)
  };
}

export function appointmentQualityByGroup(debriefs, field) {
  const map = {};
  (debriefs || []).forEach((d) => {
    const k = d[field] || "Unassigned";
    (map[k] = map[k] || []).push(d);
  });
  return Object.entries(map).map(([name, recs]) => ({ name, ...appointmentQualityStats(recs) }));
}

// ── Marketing source analytics ──
const SOURCE_ALIASES = {
  "self gen": "Self-Gen", "selfgen": "Self-Gen", "self-gen": "Self-Gen",
  "google adwords": "Google Ads",
};
export function normalizeSource(s) {
  if (!s || !String(s).trim()) return "Unassigned";
  let v = String(s).trim().replace(/\s+/g, " ");
  const lower = v.toLowerCase();
  if (SOURCE_ALIASES[lower]) return SOURCE_ALIASES[lower];
  return v;
}
export function uniqueLeadCount(recs) {
  const ids = new Set();
  let missing = 0;
  (recs || []).forEach((d) => {
    if (d.crm_lead_id && String(d.crm_lead_id).trim()) ids.add(String(d.crm_lead_id).trim().toLowerCase());
    else missing++;
  });
  return ids.size + missing;
}
export function selfGenSubsourceStats(recs) {
  const map = {};
  (recs || []).forEach((d) => {
    const k = d.self_gen_source && String(d.self_gen_source).trim() ? String(d.self_gen_source).trim() : "Unassigned";
    (map[k] = map[k] || []).push(d);
  });
  return Object.entries(map).map(([sub, r]) => {
    const aq = appointmentQualityStats(r);
    const salesRecs = r.filter(isSale);
    return {
      sub, count: r.length,
      eligibleAppts: aq.aqOpportunities + aq.aqNoSee,
      demos: aq.aqDemos, sales: salesRecs.length,
      revenue: salesRecs.reduce((s, d) => s + num(d.sale_amount), 0)
    };
  }).sort((a, b) => b.count - a.count);
}
export function marketingSourceStats(debriefs) {
  const map = {};
  nonInsuranceDebriefs(debriefs).forEach((d) => {
    const src = normalizeSource(d.marketing_source);
    (map[src] = map[src] || []).push(d);
  });
  return Object.entries(map).map(([source, recs]) => {
    const aq = appointmentQualityStats(recs);
    const tl = twoLegStats(recs);
    const salesRecs = recs.filter(isSale);
    const revenue = salesRecs.reduce((s, d) => s + num(d.sale_amount), 0);
    const firstCallCloses = recs.filter((d) => d.sale_close_type === FIRST_CALL_CLOSE).length;
    return {
      source, isUnassigned: source === "Unassigned",
      uniqueLeads: uniqueLeadCount(recs),
      missingLeadIds: recs.filter((d) => !d.crm_lead_id).length,
      eligibleAppts: aq.aqOpportunities + aq.aqNoSee,
      demos: aq.aqDemos, demoRate: aq.demoRate,
      noDemo: aq.aqNoDemo, noDemoRate: aq.noDemoRate,
      noSee: aq.aqNoSee, noSeeRate: aq.noSeeRate,
      twoLeg: tl.twoLeg, twoLegDenom: tl.denominator, twoLegRate: tl.rate,
      sales: salesRecs.length, salesRate: pct(salesRecs.length, aq.aqDemos),
      revenue, avgSale: salesRecs.length > 0 ? Math.round(revenue / salesRecs.length) : 0,
      firstCallClose: firstCallCloses,
      selfGenSubs: source === "Self-Gen" ? selfGenSubsourceStats(recs) : null,
      count: recs.length
    };
  }).sort((a, b) => b.eligibleAppts - a.eligibleAppts);
}

export function marketingCategoryStats(debriefs) {
  const map = {};
  nonInsuranceDebriefs(debriefs).forEach((d) => {
    const cat = getMarketingCategory(d.marketing_source);
    (map[cat] = map[cat] || []).push(d);
  });
  return Object.entries(map).map(([category, recs]) => {
    const aq = appointmentQualityStats(recs);
    const tl = twoLegStats(recs);
    const salesRecs = recs.filter(isSale);
    const revenue = salesRecs.reduce((s, d) => s + num(d.sale_amount), 0);
    const firstCallCloses = recs.filter((d) => d.sale_close_type === FIRST_CALL_CLOSE).length;
    return {
      category, isCleanup: category === "Other / Needs Cleanup", isSelfGen: category === "Self-Generated / Needs Detail",
      uniqueLeads: uniqueLeadCount(recs),
      missingLeadIds: recs.filter((d) => !d.crm_lead_id).length,
      eligibleAppts: aq.aqOpportunities + aq.aqNoSee,
      demos: aq.aqDemos, demoRate: aq.demoRate,
      noDemo: aq.aqNoDemo, noDemoRate: aq.noDemoRate,
      noSee: aq.aqNoSee, noSeeRate: aq.noSeeRate,
      twoLeg: tl.twoLeg, twoLegDenom: tl.denominator, twoLegRate: tl.rate,
      sales: salesRecs.length, salesRate: pct(salesRecs.length, aq.aqDemos),
      revenue, avgSale: salesRecs.length > 0 ? Math.round(revenue / salesRecs.length) : 0,
      firstCallClose: firstCallCloses,
      count: recs.length
    };
  }).sort((a, b) => b.eligibleAppts - a.eligibleAppts);
}

function safePct(a, b) { return b > 0 ? Math.round((a / b) * 100) + "%" : "—"; }

export function filterByDate(items, dateField, filter, cs, ce) {
  return items.filter((i) => {
    const val = i[dateField];
    if (!val) return false;
    const d = typeof val === "string" ? val.slice(0, 10) : val;
    return inDateRange(d, filter, cs, ce);
  });
}

// Effective sale date = sale_signed_date when populated, otherwise appointment_date.
// Used for signed-month sales/revenue attribution so a July appointment with an
// August-signed contract counts as an August sale while staying a July appointment/demo.
export function effectiveSaleDate(d) {
  const s = d && d.sale_signed_date ? String(d.sale_signed_date).slice(0, 10) : "";
  return s || (d && d.appointment_date ? String(d.appointment_date).slice(0, 10) : "");
}

export function filterByEffectiveSaleDate(items, filter, cs, ce) {
  return (items || []).filter((d) => {
    const val = effectiveSaleDate(d);
    if (!val) return false;
    return inDateRange(val, filter, cs, ce);
  });
}

export function computeKPIs(debriefs, appointments, filter, cs, ce) {
  const db = filterByDate(nonInsuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  // Sales/revenue are attributed to the signed month (effective_sale_date), not the appointment month.
  const saleDb = filterByEffectiveSaleDate(nonInsuranceDebriefs(debriefs), filter, cs, ce);
  const appts = filterByDate(salesAppointmentsOnly(nonInsuranceAppointments(appointments)), "appointment_date", filter, cs, ce);

  // Debrief lookup keys for matching Appointments (lead_id + appointment_date)
  const debriefKeys = new Set();
  db.forEach((d) => {
    if (d.crm_lead_id && d.appointment_date) {
      debriefKeys.add(d.crm_lead_id.toLowerCase().trim() + "|" + d.appointment_date);
    }
  });

  // APPOINTMENTS: Appointment Opportunities (First Appts + Reset Demos + Rehashes, excluding No C/No Shows, DQ, non-sales)
  const appointmentsCount = db.filter(isAppointmentOpportunity).length;

  // COMPLETED: all Debriefs except non-completed outcomes (includes Reset Demo visits)
  const completed = db.filter((d) => !NON_COMPLETED_OUTCOMES.includes(d.appointment_outcome)).length;

  // DEMOS: outcome beginning with "Demo Completed"
  const demos = db.filter((d) => d.appointment_outcome && d.appointment_outcome.startsWith("Demo Completed")).length;
  const demoNoSale = db.filter((d) => d.appointment_outcome === DEMO_NO_SALE_OUTCOME).length;

  // Canonical appointment-quality metrics (Demo Rate, No-Demo, No C/No Show, Reset)
  const aq = appointmentQualityStats(db);

  // SALES (signed-month attribution): sales whose effective_sale_date is in the selected period.
  const saleDebriefs = saleDb.filter((d) => isSale(d));
  const sales = saleDebriefs.length;
  const revenue = saleDebriefs.reduce((sum, d) => sum + num(d.sale_amount), 0);

  // Two-Leg uses canonical helper: numerator = Two-Leg among (First Appts + Reset Demos + Re-engagements) in qualifying divisions
  const tl = twoLegStats(db);
  const twoLeg = tl.twoLeg;
  const oneLeg = db.filter((d) => d.decision_maker_status === "One-Leg" && isTwoLegEligible(d)).length;
  const na = db.filter((d) => d.decision_maker_status === "N/A").length;

  const firstCallCloses = db.filter((d) => d.sale_close_type === FIRST_CALL_CLOSE).length;
  const financingOffered = db.filter((d) => d.financing_offered === true).length;
  const pricesGiven = db.filter((d) => num(d.prices_given) > 0).length;
  const resets = db.filter((d) => d.reset_needed === true).length;
  // No See count/rate sourced from aq (appointmentQualityStats)
  const cancellations = db.filter((d) => d.appointment_outcome === SALE_CANCELLATION_OUTCOME || d.sale_close_type === CANCELLATION_CLOSE).length;
  const creditDeclines = db.filter((d) => d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME || d.sale_close_type === CREDIT_DECLINE_CLOSE).length;

  // Missing Debriefs: past Appointments in period without matching Debrief
  const missingDebriefs = appts.filter((a) => {
    if (!a.appointment_date) return false;
    const ad = new Date(a.appointment_date + "T00:00:00");
    if (ad.getTime() >= Date.now()) return false;
    const key = (a.crm_lead_id || "").toLowerCase().trim() + "|" + a.appointment_date;
    return !debriefKeys.has(key);
  }).length;

  const demoPctVal = pct(demos, appointmentsCount);
  const salesPctVal = pct(sales, demos);
  const twoLegPctVal = tl.rate;
  const firstCallPctVal = pct(firstCallCloses, sales);
  const financingPctVal = pct(financingOffered, demos);

  return [
    { label: "Appointments", value: appointmentsCount },
    { label: "Completed", value: completed },
    { label: "Demos", value: demos },
    { label: "Demo Rate", value: safePct(aq.aqDemos, aq.aqOpportunities), rating: ratePct(aq.demoRate, 50, 40) },
    { label: "Legacy Overall Demo Rate", value: safePct(aq.aqLegacyDemos, aq.aqLegacyDenom) },
    { label: "No Demo", value: aq.aqNoDemo },
    { label: "No Demo Rate", value: safePct(aq.aqNoDemo, aq.aqAttended) },
    { label: "Demo No Sales", value: demoNoSale },
    { label: "Sales", value: sales },
    { label: "Total Sales Revenue", value: "$" + revenue.toLocaleString() },
    { label: "Average Job Size", value: sales > 0 ? "$" + Math.round(revenue / sales).toLocaleString() : "$0" },
    { label: "Sales %", value: safePct(sales, demos), rating: ratePct(salesPctVal, 50, 40) },
    { label: "Two-Leg", value: twoLeg },
    { label: "Two-Leg %", value: tl.denominator > 0 ? twoLegPctVal + "%" : "—", rating: ratePct(twoLegPctVal, 90, 80) },
    { label: "One-Leg", value: oneLeg },
    { label: "N/A", value: na },
    { label: "First Call Close", value: firstCallCloses },
    { label: "First Call Close %", value: safePct(firstCallCloses, sales), rating: ratePct(firstCallPctVal, 70, 50) },
    { label: "Prices Given", value: pricesGiven },
    { label: "Financing Offered", value: financingOffered },
    { label: "Financing Offered %", value: safePct(financingOffered, demos), rating: ratePct(financingPctVal, 50, 40) },
    { label: "Credit Declines", value: creditDeclines },
    { label: "Credit Decline %", value: safePct(creditDeclines, sales) },
    { label: "Cancellations", value: cancellations },
    { label: "Cancellation %", value: safePct(cancellations, sales) },
    { label: "Reset Needed", value: aq.aqResetNeeded },
    { label: "Reset Rate", value: safePct(aq.aqResetNeeded, aq.aqOpportunities) },
    { label: "Completed Reset Demos", value: aq.aqCompletedResetDemo },
    { label: "Reset Recovery Rate", value: safePct(aq.aqCompletedResetDemo, aq.aqResetNeeded) },
    { label: "No See", value: aq.aqNoSee },
    { label: "No See Rate", value: safePct(aq.aqNoSee, aq.aqNoSeeDenom) },
    { label: "Missing Debriefs", value: missingDebriefs }
  ];
}

function groupKPIs(debriefs, field) {
  const map = {};
  debriefs.forEach((d) => {
    const k = d[field] || "Unassigned";
    if (!map[k]) map[k] = { name: k, count: 0, demos: 0, demoNoSale: 0, sales: 0, revenue: 0, oneLeg: 0, twoLeg: 0, twoLegDenom: 0, na: 0, firstCallCloses: 0, financingOffered: 0, pricesGiven: 0, resets: 0, noC: 0, cancellations: 0, creditDeclines: 0 };
    const g = map[k];
    g.count++;
    if (DEMO_OUTCOMES.includes(d.appointment_outcome)) g.demos++;
    if (d.appointment_outcome === DEMO_NO_SALE_OUTCOME) g.demoNoSale++;
    if (SALE_OUTCOMES.includes(d.appointment_outcome)) { g.sales++; g.revenue += num(d.sale_amount); }
    if (d.decision_maker_status === "N/A") g.na++;
    if (isTwoLegEligible(d)) {
      g.twoLegDenom++;
      if (d.decision_maker_status === "Two-Leg") g.twoLeg++;
      if (d.decision_maker_status === "One-Leg") g.oneLeg++;
    }
    if (d.sale_close_type === FIRST_CALL_CLOSE) g.firstCallCloses++;
    if (d.financing_offered === true) g.financingOffered++;
    if (num(d.prices_given) > 0 || num(d.first_price_given) > 0) g.pricesGiven++;
    if (RESET_OUTCOMES.includes(d.appointment_outcome) || d.reset_needed === true) g.resets++;
    if (isNoSeeRecord(d)) g.noC++;
    if (d.appointment_outcome === SALE_CANCELLATION_OUTCOME || d.sale_close_type === CANCELLATION_CLOSE) g.cancellations++;
    if (d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME || d.sale_close_type === CREDIT_DECLINE_CLOSE) g.creditDeclines++;
  });
  return Object.values(map);
}

// Per-rep performance with signed-month sales attribution.
// Appointment-side metrics (appointments, demos, two-leg, no-demo, no-see) use appointment_date.
// Sales, revenue, and average job size use effective_sale_date (sale_signed_date, falling back to appointment_date).
export function repStats(allDebriefs, filter, cs, ce) {
  return repStatsFromDebriefs(nonInsuranceDebriefs(allDebriefs), filter, cs, ce);
}
export function repStatsFromDebriefs(filteredDebriefs, filter, cs, ce) {
  const all = filteredDebriefs;
  const apptDb = filterByDate(all, "appointment_date", filter, cs, ce);
  const saleDb = filterByEffectiveSaleDate(all, filter, cs, ce).filter(isSale);

  const apptMap = {};
  apptDb.forEach((d) => {
    const k = d.sales_rep || "Unassigned";
    if (!apptMap[k]) apptMap[k] = { name: k, appointments: 0, demos: 0, demoNoSale: 0, oneLeg: 0, twoLeg: 0, twoLegDenom: 0, na: 0, firstCallCloses: 0, financingOffered: 0, pricesGiven: 0, resets: 0, noC: 0, cancellations: 0, creditDeclines: 0 };
    const g = apptMap[k];
    if (isAppointmentOpportunity(d)) g.appointments++;
    if (DEMO_OUTCOMES.includes(d.appointment_outcome)) g.demos++;
    if (d.appointment_outcome === DEMO_NO_SALE_OUTCOME) g.demoNoSale++;
    if (d.decision_maker_status === "N/A") g.na++;
    if (isTwoLegEligible(d)) {
      g.twoLegDenom++;
      if (d.decision_maker_status === "Two-Leg") g.twoLeg++;
      if (d.decision_maker_status === "One-Leg") g.oneLeg++;
    }
    if (d.sale_close_type === FIRST_CALL_CLOSE) g.firstCallCloses++;
    if (d.financing_offered === true) g.financingOffered++;
    if (num(d.prices_given) > 0 || num(d.first_price_given) > 0) g.pricesGiven++;
    if (RESET_OUTCOMES.includes(d.appointment_outcome) || d.reset_needed === true) g.resets++;
    if (isNoSeeRecord(d)) g.noC++;
    if (d.appointment_outcome === SALE_CANCELLATION_OUTCOME || d.sale_close_type === CANCELLATION_CLOSE) g.cancellations++;
    if (d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME || d.sale_close_type === CREDIT_DECLINE_CLOSE) g.creditDeclines++;
  });

  const aqMap = {};
  appointmentQualityByGroup(apptDb, "sales_rep").forEach((g) => { aqMap[g.name] = g; });

  // Split-sale crediting. Each sale debrief is stored ONCE with the full sale_amount.
  // Primary and secondary reps each receive a fractional credit (split %) so rep totals
  // never inflate team totals (sum of credited sales = distinct sale count, sum of
  // credited revenue = full company revenue).
  const saleMap = {};
  function ensureSaleEntry(k) {
    if (!saleMap[k]) saleMap[k] = { sales: 0, revenue: 0, jobsParticipated: 0, creditedSales: 0, creditedRevenue: 0 };
    return saleMap[k];
  }
  function splitPcts(d) {
    const hasSec = !!(d.secondary_sales_rep && String(d.secondary_sales_rep).trim());
    let p = num(d.primary_rep_split_pct);
    let s = num(d.secondary_rep_split_pct);
    if (hasSec) {
      if (!p && !s) { p = 50; s = 50; }
      else if (!p) p = 100 - s;
      else if (!s) s = 100 - p;
    } else {
      p = 100; s = 0;
    }
    // Clamp/normalize so p + s === 100 and both in [0,100].
    const total = p + s;
    if (total !== 100 || p < 0 || s < 0) { p = hasSec ? 50 : 100; s = hasSec ? 50 : 0; }
    return { p, s, hasSec };
  }
  saleDb.forEach((d) => {
    const amount = num(d.sale_amount);
    const primary = d.sales_rep || "Unassigned";
    const { p, s, hasSec } = splitPcts(d);
    const pe = ensureSaleEntry(primary);
    pe.sales++;
    pe.revenue += amount;
    pe.jobsParticipated++;
    pe.creditedSales += p / 100;
    pe.creditedRevenue += amount * (p / 100);
    if (hasSec) {
      const se = ensureSaleEntry(d.secondary_sales_rep);
      se.jobsParticipated++;
      se.creditedSales += s / 100;
      se.creditedRevenue += amount * (s / 100);
    }
  });

  const names = new Set([...Object.keys(apptMap), ...Object.keys(saleMap)]);
  return [...names].map((name) => {
    const a = apptMap[name] || { appointments: 0, demos: 0, demoNoSale: 0, oneLeg: 0, twoLeg: 0, twoLegDenom: 0, na: 0, firstCallCloses: 0, financingOffered: 0, pricesGiven: 0, resets: 0, noC: 0, cancellations: 0, creditDeclines: 0 };
    const s = saleMap[name] || { sales: 0, revenue: 0, jobsParticipated: 0, creditedSales: 0, creditedRevenue: 0 };
    const aq = aqMap[name] || {};
    const sales = s.sales;
    const revenue = s.revenue;
    const jobsParticipated = s.jobsParticipated;
    const creditedSales = s.creditedSales;
    const creditedRevenue = s.creditedRevenue;
    const avgJobNum = sales > 0 ? Math.round(revenue / sales) : 0;
    const twoLegPctNum = pct(a.twoLeg, a.twoLegDenom);
    const demoRateNum = aq.demoRate || 0;
    const salesPctNum = a.demos > 0 ? Math.round((sales / a.demos) * 100) : 0;
    return {
      name,
      appointments: a.appointments,
      twoLeg: a.twoLeg, twoLegDenom: a.twoLegDenom, twoLegPctNum, twoLegPct: twoLegPctNum + "%",
      demos: a.demos, demoRateNum, demoRatePct: demoRateNum + "%",
      noDemo: aq.aqNoDemo || 0, noDemoRateNum: aq.noDemoRate || 0, noDemoRatePct: (aq.noDemoRate || 0) + "%",
      noSee: aq.aqNoSee || 0, noSeeRateNum: aq.noSeeRate || 0, noSeeRatePct: (aq.noSeeRate || 0) + "%",
      sales, salesPctNum, salesPct: salesPctNum + "%",
      revenue, avgJobNum, avgJob: "$" + avgJobNum.toLocaleString(),
      jobsParticipated, creditedSales, creditedRevenue,
      creditedSalesPct: a.demos > 0 ? Math.round((creditedSales / a.demos) * 100) : 0,
      // secondary diagnostics (kept below the primary strip)
      resetNeeded: aq.aqResetNeeded || 0, resetRateNum: aq.resetRate || 0, resetRatePct: (aq.resetRate || 0) + "%",
      completedResetDemos: aq.aqCompletedResetDemo || 0, resetRecoveryRateNum: aq.resetRecoveryRate || 0, resetRecoveryRatePct: (aq.resetRecoveryRate || 0) + "%",
      oneLeg: a.oneLeg, na: a.na, firstCallCloses: a.firstCallCloses,
      financingOffered: a.financingOffered, pricesGiven: a.pricesGiven,
      demoNoSale: a.demoNoSale, cancellations: a.cancellations, creditDeclines: a.creditDeclines,
    };
  }).sort((x, y) => y.appointments - x.appointments);
}

export function setterStats(debriefs, appointments) {
  const groups = groupKPIs(nonInsuranceDebriefs(debriefs), "appointment_setter");
  const aqMap = {};
  appointmentQualityByGroup(debriefs, "appointment_setter").forEach((g) => { aqMap[g.name] = g; });
  return groups.map((g) => {
    const missingDebriefs = salesAppointmentsOnly(appointments).filter((a) =>
      (a.original_appointment_setter === g.name || a.rehash_appointment_setter === g.name) &&
      (a.debrief_status === "Missing" || a.debrief_status === "Unmatched")
    ).length;
    const closeRate = pct(g.sales, g.demos);
    const avgJobNum = g.sales > 0 ? Math.round(g.revenue / g.sales) : 0;
    const ser = g.demos > 0 ? Math.round(g.revenue / g.demos / 100) : 0;
    const aq = aqMap[g.name] || {};
    return {
      ...g,
      aqDemos: aq.aqDemos || 0,
      aqOpportunities: aq.aqOpportunities || 0,
      aqAttended: aq.aqAttended || 0,
      aqNoDemo: aq.aqNoDemo || 0,
      aqNoSee: aq.aqNoSee || 0,
      aqResetNeeded: aq.aqResetNeeded || 0,
      aqCompletedResetDemo: aq.aqCompletedResetDemo || 0,
      closeRateNum: closeRate,
      demoRateNum: aq.demoRate || 0,
      noDemoRateNum: aq.noDemoRate || 0,
      noSeeRateNum: aq.noSeeRate || 0,
      resetRateNum: aq.resetRate || 0,
      resetRecoveryRateNum: aq.resetRecoveryRate || 0,
      twoLegPctNum: pct(g.twoLeg, g.twoLegDenom),
      firstCallClosePctNum: pct(g.firstCallCloses, g.demos),
      financingPctNum: pct(g.financingOffered, g.demos),
      avgJobNum,
      ser,
      serRating: g.demos === 0 ? "No Data" : ser >= 135 ? "Excellent" : ser >= 120 ? "Good" : "Poor",
      twoLegPct: pct(g.twoLeg, g.twoLegDenom) + "%",
      firstCallClosePct: pct(g.firstCallCloses, g.demos) + "%",
      demoPct: pct(g.demos, g.count) + "%",
      demoRatePct: (aq.demoRate || 0) + "%",
      noDemoRatePct: (aq.noDemoRate || 0) + "%",
      noSeeRatePct: (aq.noSeeRate || 0) + "%",
      resetRatePct: (aq.resetRate || 0) + "%",
      resetRecoveryRatePct: (aq.resetRecoveryRate || 0) + "%",
      salesPct: closeRate + "%",
      resetPct: pct(g.resets, g.count) + "%",
      noCPct: pct(g.noC, g.count) + "%",
      avgJob: "$" + avgJobNum.toLocaleString(),
      missingDebriefs
    };
  }).sort((a, b) => b.count - a.count);
}

export function matchDebriefToAppointment(debrief, appointments) {
  if (debrief.crm_lead_id) {
    const m = appointments.find((a) => a.crm_lead_id && a.crm_lead_id.toLowerCase().trim() === debrief.crm_lead_id.toLowerCase().trim());
    if (m) return { match: m, method: "Lead ID" };
  }
  if (debrief.phone) {
    const clean = debrief.phone.replace(/\D/g, "");
    if (clean.length >= 10) {
      const m = appointments.find((a) => a.phone && a.phone.replace(/\D/g, "").slice(-10) === clean.slice(-10));
      if (m) return { match: m, method: "Phone" };
    }
  }
  if (debrief.customer_name && debrief.appointment_date) {
    const m = appointments.find((a) =>
      a.customer_name && a.customer_name.toLowerCase().trim() === debrief.customer_name.toLowerCase().trim() &&
      a.appointment_date === debrief.appointment_date
    );
    if (m) return { match: m, method: "Name + Date" };
  }
  if (debrief.address) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const target = norm(debrief.address);
    if (target.length > 5) {
      const m = appointments.find((a) => a.address && norm(a.address) === target);
      if (m) return { match: m, method: "Address" };
    }
  }
  return null;
}

export function dataQualityFlags(d) {
  const flags = [];
  if (!d.appointment_date) flags.push("Missing appointment date");
  if (!d.sales_rep) flags.push("Missing sales rep");
  if (!d.appointment_setter) flags.push("Missing appointment setter");
  if (!d.appointment_outcome) flags.push("Missing outcome");
  if (SALE_OUTCOMES.includes(d.appointment_outcome) && !d.sale_amount) flags.push("Missing sale amount");
  if (d.crm_lead_id && !d.matched) flags.push("Unmatched Lead ID");
  if (d.appointment_outcome === SALE_CANCELLATION_OUTCOME && !d.cancellation_reason) flags.push("Cancellation with no reason");
  if (d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME && !d.financing_result) flags.push("Credit decline with no financing result");
  return flags;
}

export function buildExportRows(debriefs, appointments, filterFn) {
  const apptByLead = {};
  appointments.forEach((a) => { if (a.crm_lead_id) apptByLead[a.crm_lead_id.toLowerCase()] = a; });
  const rows = (filterFn ? (debriefs || []).filter(filterFn) : nonInsuranceDebriefs(debriefs)).map((d) => {
    const a = (d.crm_lead_id && apptByLead[d.crm_lead_id.toLowerCase()]) || {};
    const isCreditDecline = d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME || d.sale_close_type === CREDIT_DECLINE_CLOSE;
    const isCancellation = d.appointment_outcome === SALE_CANCELLATION_OUTCOME || d.sale_close_type === CANCELLATION_CLOSE;
    return {
      "Lead ID / JobProgress ID": d.crm_lead_id || a.crm_lead_id || "",
      "Customer Name": d.customer_name || "",
      "Phone Number": d.phone || "",
      "Street Address": d.address || "",
      "City": d.city || "",
      "Appointment Date": d.appointment_date || a.appointment_date || "",
      "Sales Rep": d.sales_rep || a.original_sales_rep || "",
      "Appointment Setter": d.appointment_setter || a.original_appointment_setter || "",
      "Marketing Source": d.marketing_source || a.marketing_source || "",
      "Referral Source": d.referral_source || a.referral_source || "",
      "Division": d.product || a.product || "",
      "Appointment Outcome": d.appointment_outcome || "",
      "Decision Maker Status": d.decision_maker_status || "",
      "First Price Given": d.first_price_given || "",
      "Additional Prices Given": d.additional_prices_given || "",
      "Prices Given": d.prices_given || "",
      "Financing Offered": d.financing_offered ? "Yes" : "No",
      "Financing Result": d.financing_result || "",
      "Main Objection": d.main_objection || "",
      "Pre-Close Answer": d.pre_close_answer || "",
      "Closing Question Answer": d.closing_question_answer || "",
      "Rep Response": d.rep_response || "",
      "Reset Needed": d.reset_needed ? "Yes" : "No",
      "Reset Date": d.reset_date || "",
      "Follow-Up Needed": d.follow_up_needed ? "Yes" : "No",
      "Follow-Up Date": d.follow_up_date || "",
      "Sale Amount": d.sale_amount || "",
      "Primary Sales Rep": d.sales_rep || a.original_sales_rep || "",
      "Secondary Sales Rep": d.secondary_sales_rep || "",
      "Primary Split %": d.primary_rep_split_pct != null ? d.primary_rep_split_pct : (d.secondary_sales_rep ? "" : 100),
      "Secondary Split %": d.secondary_rep_split_pct != null ? d.secondary_rep_split_pct : "",
      "Primary Revenue Credit": (d.sale_amount && d.primary_rep_split_pct != null) ? Math.round(num(d.sale_amount) * num(d.primary_rep_split_pct) / 100) : (d.sale_amount || ""),
      "Secondary Revenue Credit": (d.sale_amount && d.secondary_sales_rep && d.secondary_rep_split_pct != null) ? Math.round(num(d.sale_amount) * num(d.secondary_rep_split_pct) / 100) : "",
      "Sale / Close Type": d.sale_close_type || "",
      "Credit Decline?": isCreditDecline ? "Yes" : "No",
      "Cancellation?": isCancellation ? "Yes" : "No",
      "Cancellation Reason": d.cancellation_reason || "",
      "Submitted By": d.submitted_by || "",
      "Submitted Date/Time": d.created_date ? new Date(d.created_date).toISOString() : "",
      "Notes": d.notes || "",
      "Data Quality Flag": d.data_quality_flag || "",
      "Products Presented Other": d.products_presented_other || "",
      "Financing Not Offered Reason": d.financing_not_offered_reason || "",
      "Financing Option Presented": d.financing_option_presented || "",
      "Objection Customer Wording": d.objection_customer_wording || "",
      "Step 7 Result": d.step7_result || "",
      "Walk of Life Issues": d.walk_of_life_issues || "",
      "Step 7 Coaching Notes": d.step7_coaching_notes || "",
      "Step 7 Coaching Followup": d.step7_coaching_followup || "",
      "Step 7 Things to Review": d.step7_things_to_review || "",
      "Reset Appointment Scheduled": d.reset_appointment_scheduled === true ? "Yes" : (d.reset_appointment_scheduled === false ? "No" : ""),
      "Reset Follow-Up Notes": d.reset_follow_up_notes || "",
      "Business Division": d.business_division || "",
      "Trade": d.trade || "",
      "Contingency Signed": d.contingency_signed === true ? "Yes" : (d.contingency_signed === false ? "No" : ""),
      "Contingency Signed Date": d.contingency_signed_date || "",
      "Demo Completed": d.demo_completed === true ? "Yes" : (d.demo_completed === false ? "No" : ""),
      "Insurance Outcome": d.insurance_outcome || "",
      "Upgrade Price 1": d.upgrade_price_1 || "",
      "Upgrade Price 2": d.upgrade_price_2 || "",
      "Upgrade Price 3": d.upgrade_price_3 || "",
      "Other Prices Given": d.other_prices_given === true ? "Yes" : (d.other_prices_given === false ? "No" : ""),
      "Other Prices Details": d.other_prices_details || "",
      "Other Prices Amount": d.other_prices_amount || "",
      "Total Job Price Provided": d.total_job_price_provided === true ? "Yes" : (d.total_job_price_provided === false ? "No" : ""),
      "Total Job Price": d.total_job_price || "",
      "Upgrade Sold Accepted": d.upgrade_sold_accepted === true ? "Yes" : (d.upgrade_sold_accepted === false ? "No" : ""),
      "Accepted Upgrade Amount": d.accepted_upgrade_amount || "",
      "Final Contract Signed": d.final_contract_signed === true ? "Yes" : (d.final_contract_signed === false ? "No" : ""),
      "Final Contract Date": d.final_contract_date || ""
    };
  });
  return rows;
}

export function toCSV(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(",")];
  rows.forEach((r) => {
    lines.push(headers.map((h) => {
      const v = r[h] == null ? "" : String(r[h]);
      return `"${v.replace(/"/g, '""')}"`;
    }).join(","));
  });
  return lines.join("\n");
}