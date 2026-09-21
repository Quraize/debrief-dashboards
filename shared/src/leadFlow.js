// The Overview funnel, followed lead by lead, answering either question.
//
// In JobProgress a lead IS a job — the workflow begins at "LEAD NOT
// CONTACTED!!!" — and a lead's fate is the stage its job sits in until an
// appointment exists, and its debriefs after that. A lead is counted once
// however many visits it took: a reset is the same lead getting another
// chance to move right, not a second appointment.
//
// Two questions, one funnel:
//
//   activity (the default) — what the team DID in the range. Everything from
//     Appointment Set rightward counts leads whose appointment falls in the
//     range, however long ago the lead arrived, and reads only the debriefs
//     for visits inside it. This is the question "how many did we run".
//
//   cohort — what became of the leads that ARRIVED in the range, followed
//     wherever their appointments went, even into a later month. Good for
//     judging lead quality; it always looks weak early in a month, because
//     this month's leads have not had time to convert yet.
//
// The lead columns (Leads, Valid, Disqualified, Not Set) are the same in both:
// a lead arrives once, and that is a fact about the range either way. In
// activity mode Set therefore need not sum with Not Set to Valid — some of
// the appointments belong to leads from before the range, counted in
// `setFromEarlier`.

import { stageKey } from "./jobStages.js";
import { DEMO_OUTCOMES, NON_COMPLETED_OUTCOMES } from "./constants.js";
import { isSale, isNoSeeRecord, isNoDemoOutcome, isAppointmentOpportunity, appointmentQualityRecords } from "./kpi.js";
import { nonInsuranceDebriefs } from "./insurance.js";
import { countedDebriefs } from "./debriefApproval.js";

/**
 * Warranty callbacks on existing customers are recorded as new jobs and would
 * otherwise inflate the lead count forever, with no appointment and no reason.
 */
export const NOT_A_LEAD_STAGES = ["Open Warranty Claims/CallBacks", "Closed Warranty Claims", "Warranty"];
const NOT_A_LEAD = new Set(NOT_A_LEAD_STAGES.map(stageKey));
export const isLeadStage = (stageName) => !NOT_A_LEAD.has(stageKey(stageName));

/**
 * Disqualified: the call center or a manager moved the job to a DQ stage.
 * Pulled out of the pool FIRST, before anything about appointments — the
 * CEO's definition is valid = leads − disqualified, and a DQ'd lead that
 * somehow still has an appointment is disqualified, not set.
 */
export const DISQUALIFIED_STAGES = ["DQ (MGR APPROVAL)", "Disqualified Lead"];
const DISQUALIFIED = new Set(DISQUALIFIED_STAGES.map(stageKey));
export const isDisqualifiedStage = (stageName) => DISQUALIFIED.has(stageKey(stageName));

/** Why a VALID lead has no appointment, in display order; matched by normalised stage name. */
export const LEAD_REASONS = [
  { key: "working", label: "Still being worked",
    stages: ["LEAD NOT CONTACTED!!!", "CONTACTED NEEDS FOLLOW UP!!!", "Need to Confirm Appointment", "Appointment Set",
      "Est In Progress(MGR APPROVAL)", "Salesperson Working (MGR APPR)"] },
  { key: "hold", label: "On hold", stages: ["Project On Hold"] },
  { key: "cancelled", label: "Cancelled", stages: ["Cancel: NO FOLLOW UP(MGR APPR)", "Cancel: FOLLOW UP (MGR APPR)"] },
  { key: "dnc", label: "Do not contact", stages: ["DO NOT CONTACT", "Paid Don't Contact"] },
  { key: "other", label: "Other stage", stages: [] },
];

const REASON_BY_STAGE = new Map();
for (const r of LEAD_REASONS) for (const s of r.stages) REASON_BY_STAGE.set(stageKey(s), r.key);

/** The reason bucket for a lead with no appointment, from its stage name. */
export function leadReason(stageName) {
  return REASON_BY_STAGE.get(stageKey(stageName)) ?? "other";
}

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * Where one lead with an appointment stands, from its counted debriefs.
 *   demo      — a demo was given on some visit (sold or not is `isSale` on any of them)
 *   noDemo    — attended, no demo, on every attended visit
 *   pending   — ran, but the outcome is not settled (estimate out, result not updated)
 *   noSee     — every visit so far was a no-show or cancelled
 *   awaiting  — booked, but nothing has happened yet, or the visit has no debrief
 */
export function leadStatus(debriefs) {
  const ds = countedDebriefs(debriefs ?? []);
  if (ds.length === 0) return "awaiting";
  if (ds.some((d) => DEMO_OUTCOMES.includes(d.appointment_outcome))) return "demo";
  if (ds.some(isNoDemoOutcome)) return "noDemo";
  const settled = ds.filter((d) => !NON_COMPLETED_OUTCOMES.includes(d.appointment_outcome));
  if (settled.length === 0) return "awaiting";
  if (settled.every(isNoSeeRecord)) return "noSee";
  return "pending";
}

/**
 * Where ONE visit stands, by the same rules `leadStatus` applies to a lead's
 * whole history. Activity mode counts visits, so that the Ran and Demo cards
 * report what the Sales dashboard reports: a lead seen twice in a month is
 * two visits, and a demo is a demo whichever visit gave it.
 */
export function visitStatus(d) {
  if (countedDebriefs([d]).length === 0) return "awaiting";   // a DQ still waiting on a manager
  if (DEMO_OUTCOMES.includes(d.appointment_outcome)) return "demo";
  if (isNoDemoOutcome(d)) return "noDemo";
  if (NON_COMPLETED_OUTCOMES.includes(d.appointment_outcome)) return "awaiting";
  if (isNoSeeRecord(d)) return "noSee";
  return "pending";
}

/**
 * The visits behind each card, as lists — the funnel counts their length and
 * the detail page shows their rows, so a card and its list can never disagree.
 *
 * Each list is the population the Sales dashboard counts under that name:
 * `ran` is its Appointments (appointment opportunities), `demo` its Demos,
 * `noDemo` its No Demo, `noSee` its No See. `pending` is an opportunity that
 * neither demoed nor recorded a no-demo — a result not yet settled.
 */
export function visitBreakdown(visits) {
  const ds = nonInsuranceDebriefs(visits);
  const aq = appointmentQualityRecords(ds);
  const isDemo = (d) => String(d?.appointment_outcome ?? "").startsWith("Demo Completed");
  // Each list is the population the Sales dashboard counts under that name:
  //   ran     its Appointments (appointment opportunities)
  //   demo    its Demos        noDemo  its No Demo      noSee  its No See
  // Demos and Appointments are different populations on that dashboard too —
  // a demo given on a follow-up visit is a demo but not an opportunity — so
  // the three below need not add up to `ran`, exactly as they do not there.
  const demo = ds.filter(isDemo);
  const ran = ds.filter(isAppointmentOpportunity);
  const inNoDemo = new Set(aq.noDemos);
  const sold = demo.filter(isSale);
  return {
    demo, noDemo: aq.noDemos, noSee: aq.noSees, ran,
    pending: ran.filter((d) => !isDemo(d) && !inNoDemo.has(d)),
    sold, notSold: demo.filter((d) => !isSale(d)),
  };
}

/**
 * A debrief belongs to the range by the date of the VISIT it describes, not
 * when it was typed — a Monday debrief of a Friday demo is Friday's.
 */
function debriefInRange(d, from, to) {
  if (!from || !to) return true;
  const day = String(d?.appointment_date ?? "").slice(0, 10);
  return day >= from && day <= to;
}

/**
 * @param {Array<{ current_stage?: string|null, has_appointment: boolean, debriefs?: Array<object>,
 *   created_in_range?: boolean, appt_in_range?: boolean }>} rows
 *   Leads (jp_job rows), insurance already excluded. A row with no
 *   `created_in_range` flag is treated as having arrived in the range, so the
 *   cohort query — which returns only those — needs no flag at all.
 * @param {{ basis?: "activity"|"cohort", from?: string, to?: string, appointments?: number|null,
 *   signedRevenue?: number|null, signedSales?: number|null, visits?: Array<object>|null,
 *   awaiting?: number|null }} [opts]
 *   `signedRevenue` is the dashboards' signed-month total for the range; when given it is
 *   total for the range and `signedSales` its count; when given they are what the Sold card
 *   reports, so the card's number and its money come from one population. `visits` is every debrief for a visit in the range — the
 *   Sales dashboard's own pool. When given, activity mode counts those visits from
 *   Appointment Set rightward instead of counting leads, so the two pages agree. Without
 *   it activity mode falls back to counting leads.
 */
export function leadFunnel(rows, opts = {}) {
  const activity = opts.basis === "activity";
  const { from, to } = opts;
  const all = (rows ?? []).filter((r) => isLeadStage(r.current_stage));
  // Leads arrived in the range — the same count whichever question is asked.
  const arrived = all.filter((r) => r.created_in_range !== false);
  const dqRows = arrived.filter((r) => isDisqualifiedStage(r.current_stage));
  const validRows = arrived.filter((r) => !isDisqualifiedStage(r.current_stage));
  // Not Set stays a fact about the leads that arrived: no appointment booked
  // at all. A lead that arrived on the 30th with a visit booked for the 3rd
  // is not a failure, so it is neither Set nor Not Set in activity mode.
  const notSetRows = validRows.filter((r) => r.has_appointment !== true);
  const setRows = activity
    ? all.filter((r) => !isDisqualifiedStage(r.current_stage) && r.appt_in_range === true)
    : validRows.filter((r) => r.has_appointment === true);

  const reasonCounts = Object.fromEntries(LEAD_REASONS.map((r) => [r.key, 0]));
  for (const r of notSetRows) reasonCounts[leadReason(r.current_stage)]++;

  // Activity mode counts VISITS when it is given the dashboard's pool, so a
  // lead seen twice in the period is two visits and the Ran and Demo cards
  // match the Sales dashboard. Cohort mode counts leads, always.
  const byVisit = activity && Array.isArray(opts.visits);
  const status = { demo: 0, noDemo: 0, pending: 0, noSee: 0, awaiting: 0 };
  let sold = 0, revenue = 0, notSoldVisits = null, ranFromVisits = null;
  if (byVisit) {
    // Every card is the card of the same name on the Sales dashboard, counted
    // off the same population by the same rules, so management reads one set
    // of numbers across the platform:
    //   Ran      = its Appointments (appointment opportunities)
    //   Demo     = its Demos           No Demo = its No Demo
    //   No See   = its No See          Sold    = its Sales (signed in the range)
    // Set is those plus bookings with no debrief yet, which is the Marketing
    // dashboard's Set Appointments.
    const b = visitBreakdown(opts.visits);
    status.demo = b.demo.length;
    status.noDemo = b.noDemo.length;
    status.noSee = b.noSee.length;
    status.pending = b.pending.length;
    ranFromVisits = b.ran.length;
    sold = b.sold.length;
    notSoldVisits = b.notSold.length;
    revenue = b.sold.reduce((n, d) => n + (Number(d.sale_amount) || 0), 0);
  } else {
    for (const r of setRows) {
      const ds = activity ? (r.debriefs ?? []).filter((d) => debriefInRange(d, from, to)) : (r.debriefs ?? []);
      const s = leadStatus(ds);
      status[s]++;
      if (s === "demo") {
        const sale = countedDebriefs(ds).find(isSale);
        if (sale) { sold++; revenue += Number(sale.sale_amount) || 0; }
      }
    }
  }

  const leads = arrived.length, disqualified = dqRows.length, valid = validRows.length;
  const notSet = notSetRows.length;
  // Counting visits, a booking with no debrief yet is still Set and still
  // Awaiting, so the column sums: Set = Ran + No See + Awaiting.
  // Ran is the Sales dashboard's Appointments exactly, not a sum of the three
  // cards beside it — those are counted on their own populations, there as here.
  const ranVisits = ranFromVisits ?? (status.demo + status.noDemo + status.pending);
  if (byVisit) {
    // Bookings in the range with no debrief filed. Counted, not inferred from
    // the visit total: a reset demo often has no booking row of its own, and
    // subtracting would let the two cancel out and hide a real gap.
    status.awaiting = opts.awaiting ?? Math.max(0, (opts.appointments ?? 0) - ranVisits - status.noSee);
  }
  const set = byVisit ? ranVisits + status.noSee + status.awaiting : setRows.length;
  const setFromEarlier = activity ? setRows.filter((r) => r.created_in_range === false).length : 0;
  const soldCount = activity && opts.signedSales != null ? opts.signedSales : sold;
  const notSoldCount = notSoldVisits ?? Math.max(0, status.demo - soldCount);
  const ran = ranVisits;
  const demo = status.demo;
  return {
    basis: activity ? "activity" : "cohort",
    leads, valid, disqualified, validRate: pct(valid, leads), disqualifiedRate: pct(disqualified, leads),
    // In activity mode Set is measured against a different population from
    // Valid, so a share of valid would be a lie; the count of appointments
    // belonging to earlier leads is what the reader actually needs.
    set, notSet, setFromEarlier, setRate: activity ? null : pct(set, valid), notSetRate: pct(notSet, valid),
    /** True when Set rightward counts visits (the dashboards' basis) rather than leads. */
    byVisit,
    /** Sales appointments dated in the range, resets included — reconciles with the Marketing dashboard. */
    appointments: opts.appointments ?? null,
    reasons: LEAD_REASONS.map((r) => ({ key: r.key, label: r.label, count: reasonCounts[r.key], share: pct(reasonCounts[r.key], notSet) })),
    ran, noSee: status.noSee, awaiting: status.awaiting,
    ranRate: pct(ran, set), noSeeRate: pct(status.noSee, set), awaitingRate: pct(status.awaiting, set),
    demo, noDemo: status.noDemo, pending: status.pending,
    demoRate: pct(demo, ran), noDemoRate: pct(status.noDemo, ran), pendingRate: pct(status.pending, ran),
    // Sold is the Sales dashboard's Sales: every sale SIGNED in the range,
    // which is the same population its revenue comes from. A demo from an
    // earlier month closed now is one of them, so Sold can exceed the sales
    // made by the demos counted above — `demoSold` keeps that figure.
    // No Sale is the demos here that have not sold — counted from the same
    // list the card shows, not by subtracting a Sold that is measured on a
    // different population (sales signed in the range).
    sold: soldCount, demoSold: sold, notSold: notSoldCount,
    soldRate: pct(soldCount, demo), notSoldRate: pct(notSoldCount, demo),
    // The Sold card shows the SAME money as the Sales dashboard: every sale
    // signed in the range, whenever its demo happened (Rosco Coleman demoed
    // in August and signed on 3 September — September's money). The funnel's
    // own figure, the sales made by the demos counted above, stays as
    // `demoRevenue` so nothing that reads it loses its meaning.
    revenue: activity ? (opts.signedRevenue ?? revenue) : revenue,
    demoRevenue: revenue,
  };
}

/** Header-only view (leads / valid / disqualified / set / not set + reasons). */
export function leadFlow(rows, opts = {}) {
  const f = leadFunnel(rows, opts);
  const { leads, valid, disqualified, validRate, disqualifiedRate, set, notSet, setRate, notSetRate, reasons } = f;
  return { leads, valid, disqualified, validRate, disqualifiedRate, set, notSet, setRate, notSetRate, reasons };
}
