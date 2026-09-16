// The Overview funnel, followed lead by lead.
//
// In JobProgress a lead IS a job — the workflow begins at "LEAD NOT
// CONTACTED!!!" — and a lead's fate is the stage its job sits in until an
// appointment exists, and its debriefs after that. Every box here is a count
// of LEADS created in the range, followed wherever their appointments go, so
// each column sums exactly to the box that feeds it and a lead is counted
// once: a reset visit is the same lead getting another chance to move right,
// not a second appointment.
//
// This deliberately differs from the Marketing and Sales dashboards, which
// count appointments by appointment date. Those answer "what happened this
// month"; this answers "what became of this month's leads".

import { stageKey } from "./jobStages.js";
import { DEMO_OUTCOMES, NON_COMPLETED_OUTCOMES } from "./constants.js";
import { isSale, isNoSeeRecord, isNoDemoOutcome } from "./kpi.js";
import { countedDebriefs } from "./debriefApproval.js";

/**
 * Warranty callbacks on existing customers are recorded as new jobs and would
 * otherwise inflate the lead count forever, with no appointment and no reason.
 */
export const NOT_A_LEAD_STAGES = ["Open Warranty Claims/CallBacks", "Closed Warranty Claims", "Warranty"];
const NOT_A_LEAD = new Set(NOT_A_LEAD_STAGES.map(stageKey));
export const isLeadStage = (stageName) => !NOT_A_LEAD.has(stageKey(stageName));

/** Why a lead has no appointment, in display order; matched by normalised stage name. */
export const LEAD_REASONS = [
  { key: "dq", label: "Disqualified", stages: ["DQ (MGR APPROVAL)", "Disqualified Lead"] },
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
 * @param {Array<{ current_stage?: string|null, has_appointment: boolean, debriefs?: Array<object> }>} rows
 *   Jobs created in the range, insurance already excluded.
 */
export function leadFunnel(rows) {
  const all = (rows ?? []).filter((r) => isLeadStage(r.current_stage));
  const notSetRows = all.filter((r) => r.has_appointment !== true);
  const setRows = all.filter((r) => r.has_appointment === true);

  const reasonCounts = Object.fromEntries(LEAD_REASONS.map((r) => [r.key, 0]));
  for (const r of notSetRows) reasonCounts[leadReason(r.current_stage)]++;

  const status = { demo: 0, noDemo: 0, pending: 0, noSee: 0, awaiting: 0 };
  let sold = 0, revenue = 0;
  for (const r of setRows) {
    const s = leadStatus(r.debriefs);
    status[s]++;
    if (s === "demo") {
      const sale = countedDebriefs(r.debriefs ?? []).find(isSale);
      if (sale) { sold++; revenue += Number(sale.sale_amount) || 0; }
    }
  }

  const leads = all.length, set = setRows.length, notSet = notSetRows.length;
  const ran = status.demo + status.noDemo + status.pending;
  const demo = status.demo;
  return {
    leads, set, notSet, setRate: pct(set, leads), notSetRate: pct(notSet, leads),
    reasons: LEAD_REASONS.map((r) => ({ key: r.key, label: r.label, count: reasonCounts[r.key], share: pct(reasonCounts[r.key], notSet) })),
    ran, noSee: status.noSee, awaiting: status.awaiting,
    ranRate: pct(ran, set), noSeeRate: pct(status.noSee, set), awaitingRate: pct(status.awaiting, set),
    demo, noDemo: status.noDemo, pending: status.pending,
    demoRate: pct(demo, ran), noDemoRate: pct(status.noDemo, ran), pendingRate: pct(status.pending, ran),
    sold, notSold: demo - sold, revenue, soldRate: pct(sold, demo), notSoldRate: pct(demo - sold, demo),
  };
}

/** Back-compatible header-only view (leads / set / not set + reasons). */
export function leadFlow(rows) {
  const f = leadFunnel(rows);
  return { leads: f.leads, set: f.set, notSet: f.notSet, setRate: f.setRate, notSetRate: f.notSetRate, reasons: f.reasons };
}
