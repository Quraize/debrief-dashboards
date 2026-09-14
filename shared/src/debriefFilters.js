// Slicing a debrief list the way the Sales dashboard needs it.
//
// The dashboards each hold their own filter UI, but the rules for what a
// selection MEANS belong in one place: "rep" is not simply sales_rep (a split
// sale credits a secondary rep too), "trade" is one entry inside a
// comma-separated list, and appointment types arrive in several legacy
// spellings. Getting any of those subtly wrong changes a manager's numbers
// without looking wrong, which is exactly what tests are for.

import { normalizeAppointmentType } from "./appointmentTypes.js";
import { getMarketingCategory } from "./marketingSources.js";
// normalizeSource lives in kpi.js with the other source-cleanup rules. The
// dependency runs one way — kpi.js knows nothing about this module.
import { normalizeSource } from "./kpi.js";

/** The filter shape. Every field is a string; "" means "no filter". */
export const EMPTY_DEBRIEF_FILTERS = Object.freeze({
  rep: "", setter: "", apptType: "", mktCategory: "", source: "", trade: "",
});

/** Human labels, in the order the bar shows them. */
export const DEBRIEF_FILTER_LABELS = Object.freeze({
  rep: "Sales Rep", setter: "Appointment Setter", apptType: "Appointment Type",
  mktCategory: "Marketing Category", source: "Marketing Source", trade: "Trade",
});

const str = (v) => (v == null ? "" : String(v).trim());

/** The trades on a debrief. Stored as "Roofing, Siding" by the form. */
export function debriefTrades(d) {
  return str(d?.trade).split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * True when the rep owns any part of this debrief. A split sale credits the
 * secondary rep, and this dashboard reports credited revenue — filtering on
 * sales_rep alone would drop a rep's split jobs and undercount them.
 */
export function debriefHasRep(d, rep) {
  const want = str(rep).toLowerCase();
  if (!want) return true;
  return [d?.sales_rep, d?.secondary_sales_rep].some((r) => str(r).toLowerCase() === want);
}

/** Applies every set filter. Unset fields are skipped, so this is cheap. */
export function applyDebriefFilters(rows, filters) {
  const f = { ...EMPTY_DEBRIEF_FILTERS, ...(filters ?? {}) };
  let out = rows ?? [];
  if (f.rep) out = out.filter((d) => debriefHasRep(d, f.rep));
  if (f.setter) out = out.filter((d) => str(d.appointment_setter) === f.setter);
  if (f.apptType) out = out.filter((d) => normalizeAppointmentType(d.appointment_type) === f.apptType);
  if (f.mktCategory) out = out.filter((d) => getMarketingCategory(d.marketing_source) === f.mktCategory);
  if (f.source) out = out.filter((d) => normalizeSource(d.marketing_source) === f.source);
  if (f.trade) out = out.filter((d) => debriefTrades(d).includes(f.trade));
  return out;
}

/**
 * The values actually present in the data, so a dropdown never offers a name
 * that would return nothing. Appointment types come from the canonical list
 * because the legacy spellings are normalised away.
 */
export function debriefFilterOptions(rows) {
  const reps = new Set(), setters = new Set(), apptTypes = new Set(), sources = new Set(), trades = new Set();
  for (const d of rows ?? []) {
    for (const r of [d.sales_rep, d.secondary_sales_rep]) if (str(r)) reps.add(str(r));
    if (str(d.appointment_setter)) setters.add(str(d.appointment_setter));
    const t = normalizeAppointmentType(d.appointment_type);
    if (t) apptTypes.add(t);
    const s = normalizeSource(d.marketing_source);
    if (s) sources.add(s);
    for (const tr of debriefTrades(d)) trades.add(tr);
  }
  // "Unassigned" last in the source list: it is a data-quality bucket, not a source.
  const sorted = (set) => [...set].sort((a, b) => a.localeCompare(b));
  return {
    reps: sorted(reps),
    setters: sorted(setters),
    apptTypes: sorted(apptTypes),
    sources: [...sources].sort((a, b) => (a === "Unassigned" ? 1 : 0) - (b === "Unassigned" ? 1 : 0) || a.localeCompare(b)),
    trades: sorted(trades),
  };
}

/** How many filters are set — for the "N filters active" chip. */
export function activeFilterCount(filters) {
  return Object.keys(EMPTY_DEBRIEF_FILTERS).filter((k) => str(filters?.[k])).length;
}

/** What is selected, as [{ key, label, value }], in display order. */
export function describeFilters(filters) {
  return Object.keys(EMPTY_DEBRIEF_FILTERS)
    .filter((k) => str(filters?.[k]))
    .map((k) => ({ key: k, label: DEBRIEF_FILTER_LABELS[k], value: str(filters[k]) }));
}
