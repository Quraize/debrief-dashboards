// Results Review: what the CRM says about each debrief, and where they disagree.
//
// A debrief is the rep's account of an appointment; the CRM result form is the
// office's. Both should describe the same visit. This module joins a debrief
// to its CRM mirror (same Lead ID + date key as the queue and the KPI engine)
// and lists every disagreement a manager would want to see: outcome, contract
// value, Two-Leg, and the rep of record. Nothing here changes either side.

import { isSale } from "./kpi.js";
import { DEMO_OUTCOMES, NON_COMPLETED_OUTCOMES } from "./constants.js";
import { enrichQueueItem } from "./debriefQueue.js";
import { nameKey } from "./jpCallCenter.js";

/** Debrief outcomes that mean the customer was not seen. */
const NO_SHOW_OUTCOME = /no\s*c\b|no\s*show|no\s*see/i;

/** Contract values are "the same" within this much: the larger of $500 or 5%. */
export const AMOUNT_TOLERANCE_ABS = 500;
export const AMOUNT_TOLERANCE_PCT = 0.05;

export const DISCREPANCY_LABELS = {
  outcome_sale: "Sale recorded on one side only",
  outcome_demo: "Demo on one side, no demo on the other",
  outcome_no_see: "CRM says No See, debrief says the customer was seen",
  outcome_cancelled: "CRM says cancelled, debrief says the appointment ran",
  crm_no_result: "CRM result form not filled in",
  amount: "Contract value differs",
  two_leg: "Two-Leg answer differs",
  rep: "Sales rep differs",
};

/** Mismatches that matter for the numbers; the rest is housekeeping. */
export const HARD_DISCREPANCIES = new Set(["outcome_sale", "outcome_demo", "outcome_no_see", "outcome_cancelled", "amount", "two_leg"]);

const TWO_LEG_DEBRIEF = { "two-leg": "two_leg", "one-leg": "one_leg" };
const TWO_LEG_LABEL = { two_leg: "Two-Leg", one_leg: "One-Leg", other: "Other" };
const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

/** "Jason" vs "Jason Malarchak" is the same person; "Pema" vs "Jason" is not. */
export function sameRep(a, b) {
  const ka = nameKey(a), kb = nameKey(b);
  if (!ka || !kb) return true; // nothing to compare
  if (ka === kb) return true;
  const ta = ka.split(" "), tb = kb.split(" ");
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return short.every((t) => long.includes(t));
}

export function amountsDiffer(a, b) {
  const x = Number(a), y = Number(b);
  if (!(x > 0) || !(y > 0)) return false;
  return Math.abs(x - y) > Math.max(AMOUNT_TOLERANCE_ABS, Math.max(x, y) * AMOUNT_TOLERANCE_PCT);
}

/**
 * @param debrief  a debrief row
 * @param ctx      { jpByKey, customersById, jobsById } from debriefQueue's indexers
 * @returns {{ crm, lead, job, matched: boolean, discrepancies: Array<{code,label,debrief,crm}>, severity: 'unmatched'|'ok'|'info'|'mismatch' }}
 */
export function compareDebriefToCrm(debrief, ctx, now = new Date()) {
  const { crm, lead, job } = enrichQueueItem(
    { crm_lead_id: debrief.crm_lead_id, crm_job_id: debrief.crm_job_id, appointment_date: debrief.appointment_date }, ctx, now);
  if (!crm) return { crm: null, lead, job, matched: false, discrepancies: [], severity: "unmatched" };

  const out = [];
  const add = (code, dv, cv) => out.push({ code, label: DISCREPANCY_LABELS[code], debrief: dv, crm: cv });

  const outcome = String(debrief.appointment_outcome ?? "");
  const dSale = isSale(debrief);
  const dDemo = DEMO_OUTCOMES.includes(outcome) || dSale;
  const dNoShow = NO_SHOW_OUTCOME.test(outcome);
  const dNotRun = NON_COMPLETED_OUTCOMES.includes(outcome);
  const crmResult = crm.result || "—";

  if (crm.status === "run") {
    if (dSale !== crm.isSale) add("outcome_sale", outcome || "—", crmResult);
    else if (dDemo !== crm.isDemo && !dNotRun) add("outcome_demo", outcome || "—", crmResult);
  } else if (crm.status === "no_see") {
    if (!dNoShow && !dNotRun) add("outcome_no_see", outcome || "—", crmResult);
  } else if (crm.status === "cancelled") {
    if (dDemo || dNoShow) add("outcome_cancelled", outcome || "—", "Cancelled");
  } else if (crm.status === "awaiting" || crm.status === "no_result") {
    if (!dNotRun) add("crm_no_result", outcome || "—", "No result");
  }

  if (dSale && crm.isSale && job?.price != null && amountsDiffer(debrief.sale_amount, job.price)) {
    add("amount", money(debrief.sale_amount), money(job.price));
  }

  const dLeg = TWO_LEG_DEBRIEF[String(debrief.decision_maker_status ?? "").toLowerCase()];
  if (dLeg && crm.twoLeg && crm.twoLeg !== "other" && dLeg !== crm.twoLeg) {
    add("two_leg", TWO_LEG_LABEL[dLeg], `${TWO_LEG_LABEL[crm.twoLeg]}${crm.twoLegRaw ? ` ("${crm.twoLegRaw}")` : ""}`);
  }

  if (!sameRep(debrief.sales_rep, crm.salesRep)) add("rep", debrief.sales_rep || "—", crm.salesRep || "—");

  const severity = out.some((d) => HARD_DISCREPANCIES.has(d.code)) ? "mismatch" : out.length ? "info" : "ok";
  return { crm, lead, job, matched: true, discrepancies: out, severity };
}

/**
 * Roll-up for a set of compared debriefs.
 * crmRevenue = CRM contract value of the debriefs the CRM also calls a sale;
 * debriefRevenue = what the reps entered for the same set of debriefs.
 */
export function debriefCrmSummary(rows) {
  const s = { total: 0, matched: 0, ok: 0, info: 0, mismatch: 0, unmatched: 0, crmSales: 0, crmRevenue: 0, crmSalesMissingAmount: 0, debriefRevenue: 0 };
  for (const { debrief, cmp } of rows || []) {
    s.total++;
    s[cmp.severity]++;
    if (cmp.matched) s.matched++;
    s.debriefRevenue += isSale(debrief) ? Number(debrief.sale_amount) || 0 : 0;
    if (cmp.crm?.isSale) {
      s.crmSales++;
      if (cmp.job?.price != null) s.crmRevenue += cmp.job.price; else s.crmSalesMissingAmount++;
    }
  }
  return s;
}

export const CRM_CHECK_FILTERS = [
  ["all", "All"], ["mismatch", "CRM mismatch"], ["info", "Needs attention"], ["ok", "Matches CRM"], ["unmatched", "Not in CRM"],
];
