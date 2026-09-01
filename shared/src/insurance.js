// Insurance division helpers — shared across dashboards, forms, and exports.
// Insurance is a true business division, separate from Residential Retail and Commercial.
// Insurance records are excluded from all standard retail KPIs and totals.

import { inDateRange } from "./constants.js";

// Inlined to avoid circular dependency with kpi.js
function safeNum(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function filterByDate(items, dateField, filter, cs, ce) {
  return (items || []).filter((i) => {
    const val = i[dateField];
    if (!val) return false;
    const d = typeof val === "string" ? val.slice(0, 10) : val;
    return inDateRange(d, filter, cs, ce);
  });
}

const INSURANCE = "Insurance";

/**
 * True when a debrief is an Insurance division record.
 * Checks business_division first, falls back to product for records
 * where only the Division dropdown was set to "Insurance".
 */
export function isInsuranceDebrief(d) {
  if (!d) return false;
  return d.business_division === INSURANCE || d.product === INSURANCE;
}

/**
 * Filter to non-Insurance debriefs only (retail + commercial).
 * Records where business_division/product is unset are kept (historical).
 */
export function nonInsuranceDebriefs(debriefs) {
  return (debriefs || []).filter((d) => !isInsuranceDebrief(d));
}

/**
 * Filter to Insurance debriefs only.
 */
export function insuranceDebriefs(debriefs) {
  return (debriefs || []).filter(isInsuranceDebrief);
}

/**
 * True when an appointment is an Insurance division record.
 */
export function isInsuranceAppointment(a) {
  if (!a) return false;
  return a.business_division === INSURANCE || a.product === INSURANCE;
}

/**
 * Filter to non-Insurance appointments only (retail + commercial).
 */
export function nonInsuranceAppointments(appointments) {
  return (appointments || []).filter((a) => !isInsuranceAppointment(a));
}

/**
 * Filter to Insurance appointments only.
 */
export function insuranceAppointments(appointments) {
  return (appointments || []).filter(isInsuranceAppointment);
}

function pct(a, b) {
  const na = safeNum(a);
  return b > 0 ? Math.round((na / b) * 100) : 0;
}

/**
 * Compute Insurance KPIs per the Rodney Webb Insurance Efficiency workbook.
 *
 * - Issued Leads = Insurance appointment records in range
 * - Demos = Insurance debriefs with demo_completed = Yes
 * - Demo % = Demos / (Issued Leads - No See), zero-safe
 * - No Damage % = No Damage / Issued Leads
 * - Reset % = Reset Needed / Issued Leads
 * - No See % = No See / Issued Leads
 * - Contingencies = contingency_signed = Yes
 * - Contingency % (Contingency Rate) = Contingencies / Demos, zero-safe
 * - Upgrade Sold % = Upgrade Accepted / Contingencies, zero-safe
 * - Final Contract % = Final Contract Signed / Contingencies, zero-safe
 * - Sum Upgrade Revenue and Total Job Price separately
 *
 * Does NOT implement the legacy Insurance Efficiency Ratio score — the workbook
 * contains #REF/#DIV0 errors and a hard-coded scoring grid. Component KPIs are
 * kept visible and auditable instead.
 *
 * @returns {{ kpis: Array, warnings: Array, raw: Object }}
 */
export function computeInsuranceKPIs(debriefs, appointments, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const insAppts = filterByDate(insuranceAppointments(appointments), "appointment_date", filter, cs, ce);

  // Issued Leads = Insurance appointment records in range.
  // Use appointments as the denominator source; fall back to debriefs if no appointments.
  const issuedLeads = insAppts.length > 0 ? insAppts.length : insDb.length;

  // Demos = Insurance debriefs with demo_completed = Yes
  const demos = insDb.filter((d) => d.demo_completed === true).length;

  // Outcome-based counts
  const noDamage = insDb.filter((d) => d.insurance_outcome === "No Damage").length;
  const resetNeeded = insDb.filter((d) => d.insurance_outcome === "Reset Needed").length;
  const noSee = insDb.filter((d) => d.insurance_outcome === "No See/Cancelled").length;
  const dq = insDb.filter((d) => d.insurance_outcome === "DQ").length;
  const pending = insDb.filter((d) => d.insurance_outcome === "Pending").length;

  // Demo % = Demos / (Issued Leads - No See), zero-safe
  const demoDenom = issuedLeads - noSee;
  const demoPct = pct(demos, demoDenom);

  // Contingencies = contingency_signed = Yes
  const contingencies = insDb.filter((d) => d.contingency_signed === true).length;

  // Contingency Rate = Contingencies / Demos, zero-safe
  const contingencyPct = pct(contingencies, demos);

  // Upgrade Sold % = Upgrade Accepted / Contingencies, zero-safe
  const upgradeAccepted = insDb.filter((d) => d.upgrade_sold_accepted === true).length;
  const upgradeSoldPct = pct(upgradeAccepted, contingencies);

  // Final Contract % = Final Contract Signed / Contingencies, zero-safe
  const finalContractSigned = insDb.filter((d) => d.final_contract_signed === true).length;
  const finalContractPct = pct(finalContractSigned, contingencies);

  // Revenue: sum upgrade revenue and total job price separately
  const upgradeRevenue = insDb
    .filter((d) => d.upgrade_sold_accepted === true)
    .reduce((s, d) => s + safeNum(d.accepted_upgrade_amount), 0);
  const totalJobPrice = insDb
    .filter((d) => d.total_job_price_provided === true)
    .reduce((s, d) => s + safeNum(d.total_job_price), 0);

  // Data-quality warnings: any rate exceeding 100%
  const warnings = [];
  if (demoDenom > 0 && demoPct > 100) warnings.push("Demo % exceeds 100% — check for data-entry errors (Demos > Issued Leads − No See).");
  if (demos > 0 && contingencyPct > 100) warnings.push("Contingency Rate exceeds 100% — more contingencies than demos recorded.");
  if (contingencies > 0 && upgradeSoldPct > 100) warnings.push("Upgrade Sold % exceeds 100% — more upgrades accepted than contingencies.");
  if (contingencies > 0 && finalContractPct > 100) warnings.push("Final Contract % exceeds 100% — more contracts than contingencies.");

  const kpis = [
    { label: "Issued Leads", value: issuedLeads },
    { label: "Demos", value: demos },
    { label: "Demo %", value: demoDenom > 0 ? demoPct + "%" : "—", rating: demoPct > 100 ? "red" : null },
    { label: "No Damage", value: noDamage },
    { label: "No Damage %", value: pct(noDamage, issuedLeads) + "%" },
    { label: "Reset Needed", value: resetNeeded },
    { label: "Reset %", value: pct(resetNeeded, issuedLeads) + "%" },
    { label: "No See", value: noSee },
    { label: "No See %", value: pct(noSee, issuedLeads) + "%" },
    { label: "DQ", value: dq },
    { label: "Pending", value: pending },
    { label: "Contingencies", value: contingencies },
    { label: "Contingency Rate", value: demos > 0 ? contingencyPct + "%" : "—", rating: contingencyPct > 100 ? "red" : null },
    { label: "Upgrade Sold", value: upgradeAccepted },
    { label: "Upgrade Sold %", value: contingencies > 0 ? upgradeSoldPct + "%" : "—", rating: upgradeSoldPct > 100 ? "red" : null },
    { label: "Final Contract Signed", value: finalContractSigned },
    { label: "Final Contract %", value: contingencies > 0 ? finalContractPct + "%" : "—", rating: finalContractPct > 100 ? "red" : null },
    { label: "Upgrade Revenue", value: "$" + upgradeRevenue.toLocaleString() },
    { label: "Total Job Price", value: "$" + totalJobPrice.toLocaleString() },
  ];

  return { kpis, warnings, raw: { issuedLeads, demos, noDamage, resetNeeded, noSee, dq, pending, contingencies, upgradeAccepted, finalContractSigned, upgradeRevenue, totalJobPrice, demoPct, contingencyPct, upgradeSoldPct, finalContractPct } };
}

/**
 * Insurance funnel stages for visualization.
 */
export function insuranceFunnelData(debriefs, appointments, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const insAppts = filterByDate(insuranceAppointments(appointments), "appointment_date", filter, cs, ce);
  const issuedLeads = insAppts.length > 0 ? insAppts.length : insDb.length;
  const demos = insDb.filter((d) => d.demo_completed === true).length;
  const contingencies = insDb.filter((d) => d.contingency_signed === true).length;
  const upgrades = insDb.filter((d) => d.upgrade_sold_accepted === true).length;
  const contracts = insDb.filter((d) => d.final_contract_signed === true).length;
  return [
    { stage: "Issued Leads", value: issuedLeads },
    { stage: "Demos", value: demos },
    { stage: "Contingencies", value: contingencies },
    { stage: "Upgrades Sold", value: upgrades },
    { stage: "Final Contracts", value: contracts },
  ];
}

/**
 * Insurance status breakdown for pie/bar chart.
 */
export function insuranceStatusBreakdown(debriefs, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const map = {};
  insDb.forEach((d) => {
    const k = d.insurance_outcome || "Unspecified";
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

/**
 * Insurance trade mix for pie chart.
 */
export function insuranceTradeMix(debriefs, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const map = {};
  insDb.forEach((d) => {
    const k = d.trade || "Unspecified";
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map).map(([name, value]) => ({ name, value }));
}

/**
 * Insurance marketing-source breakdown.
 */
export function insuranceSourceBreakdown(debriefs, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const map = {};
  insDb.forEach((d) => {
    const k = (d.marketing_source || "").trim() || "Unassigned";
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

/**
 * Insurance rep performance table.
 */
export function insuranceRepTable(debriefs, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const map = {};
  insDb.forEach((d) => {
    const k = d.sales_rep || "Unassigned";
    if (!map[k]) map[k] = { rep: k, count: 0, demos: 0, contingencies: 0, upgrades: 0, contracts: 0, upgradeRevenue: 0, jobPrice: 0 };
    const g = map[k];
    g.count++;
    if (d.demo_completed === true) g.demos++;
    if (d.contingency_signed === true) g.contingencies++;
    if (d.upgrade_sold_accepted === true) { g.upgrades++; g.upgradeRevenue += safeNum(d.accepted_upgrade_amount); }
    if (d.final_contract_signed === true) g.contracts++;
    g.jobPrice += safeNum(d.total_job_price);
  });
  return Object.values(map).sort((a, b) => b.count - a.count);
}

/**
 * Monthly trend for Insurance demos and contingencies.
 */
export function insuranceMonthlyTrend(debriefs, filter, cs, ce) {
  const insDb = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const map = {};
  insDb.forEach((d) => {
    if (!d.appointment_date) return;
    const month = d.appointment_date.slice(0, 7);
    if (!map[month]) map[month] = { month, demos: 0, contingencies: 0, contracts: 0 };
    if (d.demo_completed === true) map[month].demos++;
    if (d.contingency_signed === true) map[month].contingencies++;
    if (d.final_contract_signed === true) map[month].contracts++;
  });
  return Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
}