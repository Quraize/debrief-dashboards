// Marketing attribution from the CRM mirror (jp_customer + jp_appointment + jp_job).
//
// The lead source lives on the JobProgress CUSTOMER, recorded at intake:
//   referred_by_type = "referral"  → one of the office's referral sources (by name)
//   referred_by_type = "customer"  → an existing customer referred them
//   otherwise                      → maybe a free-text note, maybe nothing
// Appointments and jobs inherit the source through jp_customer_id. The
// category rollup is the same 14-category taxonomy the debrief dashboard
// uses (marketingSources.js), because the CRM's referral names ARE the
// debrief dropdown's values.
//
// Attribution windows follow the debrief dashboard's conventions:
//   leads          → by the customer's CRM creation date
//   appointments…  → by appointment date (run appointments only, see jpStats)
//   sales $        → contract value of the sold job, appointment month

import { filterByDate } from "./kpi.js";
import { getMarketingCategory, isUnmappedSource } from "./marketingSources.js";
import { isRunAppointment, isNoShowResult, isDemoResult, isSaleResult } from "./jpStats.js";

const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

export const CUSTOMER_REFERRAL_SOURCE = "Existing Client Referral";
export const UNKNOWN_SOURCE = "Unknown (no source in CRM)";

/**
 * The lead source of a CRM customer row, resolved to the dropdown vocabulary.
 * @returns {{ source: string, kind: "referral"|"customer"|"note"|"unknown" }}
 */
export function jpLeadSource(customer) {
  if (!customer) return { source: UNKNOWN_SOURCE, kind: "unknown" };
  const name = String(customer.referred_by_name ?? "").trim();
  if (name) return { source: name, kind: "referral" };
  if (String(customer.referred_by_type ?? "").toLowerCase() === "customer") {
    return { source: CUSTOMER_REFERRAL_SOURCE, kind: "customer" };
  }
  const note = String(customer.referred_by_note ?? "").trim();
  if (note) return { source: `Note: ${note.slice(0, 40)}`, kind: "note" };
  return { source: UNKNOWN_SOURCE, kind: "unknown" };
}

export function jpLeadCategory(lead) {
  if (lead.kind === "customer") return "Existing Customer / Referral";
  if (lead.kind === "referral") return getMarketingCategory(lead.source);
  return "Other / Needs Cleanup";
}

export const JP_MARKETING_DEFINITIONS = {
  leads: "CRM leads: customers created in JobProgress in this period, every source, whether or not they were ever appointed or debriefed.",
  appointments: "Sales appointments actually run in this period (result recorded, not a no-show), attributed to the customer's CRM lead source.",
  leadToAppt: "Appointments run ÷ leads created in the same period. A rough conversion: an appointment can belong to a lead created earlier.",
  demos: "Run appointments with result $ale!!! or Demo No Sale.",
  sales: "Run appointments with result $ale!!!.",
  salesAmount: "Contract value of the jobs sold at those appointments (JobProgress financials), by appointment month.",
  customerReferrals: "Leads the CRM marks as referred by an existing customer.",
  unknownSource: "Leads with no referral source and no note in the CRM — intake never recorded where they came from.",
  noteSource: "Leads whose only source is a free-text note (e.g. \"referred by Steve\") — not a dropdown value, so they roll up to Other / Needs Cleanup.",
  unmapped: "Referral sources the CRM uses that the dashboard's category map does not know yet.",
};

function bucket(label) {
  return { label, leads: 0, customerReferrals: 0, appointments: 0, noShows: 0, demos: 0, sales: 0,
    salesAmount: 0, salesMissingAmount: 0, kindCounts: { referral: 0, customer: 0, note: 0, unknown: 0 } };
}
function finish(b) {
  return {
    ...b,
    leadToApptRate: pct(b.appointments, b.leads),
    demoRate: pct(b.demos, b.appointments),
    closeRate: pct(b.sales, b.demos),
    leadToSaleRate: pct(b.sales, b.leads),
    avgSale: b.sales - b.salesMissingAmount > 0 ? Math.round(b.salesAmount / (b.sales - b.salesMissingAmount)) : 0,
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
 * @param customers    jp_customer rows
 * @param appointments jp_appointment rows
 * @param jobs         jp_job rows (sale amounts by crm_job_id)
 */
export function jpMarketingStats(customers, appointments, jobs, filter, cs, ce) {
  const custById = new Map();
  for (const c of customers || []) if (c.jp_customer_id != null) custById.set(String(c.jp_customer_id), c);
  const jobById = new Map();
  for (const j of jobs || []) if (j.jp_job_id != null) jobById.set(String(j.jp_job_id), j);

  const total = bucket("Total");
  const bySource = new Map();
  const byCategory = new Map();
  const leadsByMonth = new Map();
  const unmapped = new Set();
  const get = (map, key) => { if (!map.has(key)) map.set(key, bucket(key)); return map.get(key); };
  const targets = (lead) => {
    const cat = jpLeadCategory(lead);
    if (lead.kind === "referral" && isUnmappedSource(lead.source)) unmapped.add(lead.source);
    return [total, get(bySource, lead.source), get(byCategory, cat)];
  };

  // Leads: customers created in the period.
  const leadRows = (customers || [])
    .map((c) => ({ ...c, lead_date: String(c.jp_created_at ?? "").slice(0, 10) }))
    .filter((c) => c.lead_date);
  for (const c of filterByDate(leadRows, "lead_date", filter, cs, ce)) {
    const lead = jpLeadSource(c);
    for (const b of targets(lead)) {
      b.leads++;
      b.kindCounts[lead.kind]++;
      if (lead.kind === "customer") b.customerReferrals++;
    }
    const m = c.lead_date.slice(0, 7);
    leadsByMonth.set(m, (leadsByMonth.get(m) ?? 0) + 1);
  }

  // Appointments in the period, attributed through their customer.
  const inRange = filterByDate(appointments || [], "appointment_date", filter, cs, ce)
    .filter((r) => r.is_sales_type === true && r.is_insurance !== true);
  for (const r of inRange) {
    const lead = jpLeadSource(r.jp_customer_id != null ? custById.get(String(r.jp_customer_id)) : null);
    const bs = targets(lead);
    if (r.has_result === true && isNoShowResult(r)) { for (const b of bs) b.noShows++; continue; }
    if (!isRunAppointment(r)) continue;
    const sale = isSaleResult(r);
    const amount = sale ? jobAmount(r.crm_job_id != null ? jobById.get(String(r.crm_job_id)) : null) : null;
    for (const b of bs) {
      b.appointments++;
      if (isDemoResult(r)) b.demos++;
      if (sale) {
        b.sales++;
        if (amount != null) b.salesAmount += amount;
        else b.salesMissingAmount++;
      }
    }
  }

  const rows = (map) => [...map.values()].map(finish)
    .sort((a, b) => b.leads - a.leads || b.appointments - a.appointments || a.label.localeCompare(b.label));

  return {
    ...finish(total),
    bySource: rows(bySource),
    byCategory: rows(byCategory),
    leadsByMonth: [...leadsByMonth.entries()].map(([month, leads]) => ({ month, leads })).sort((a, b) => a.month.localeCompare(b.month)),
    unmappedSources: [...unmapped].sort(),
    unknownLeads: total.kindCounts.unknown,
    noteLeads: total.kindCounts.note,
  };
}
