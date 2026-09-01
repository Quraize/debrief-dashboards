// Shared appointment classification — single source of truth for import, KPI, dashboards, and UI.
// Derives reporting_division (operating bucket) from raw JobProgress Division, Trade, or appointment title.
// Operating buckets: Roofing, Siding, Roofing + Siding, Commercial, Repairs, Misc, Insurance, Non-Sales, Unclassified.
// Never overwrites raw source fields; derived classification is computed on read.

import { isNonSalesTitle } from "./nonSalesActivity.js";

export const REPORT_DIVISIONS = ["Roofing", "Siding", "Roofing + Siding", "Commercial", "Repairs", "Misc", "Insurance", "Non-Sales", "Unclassified"];
export const TWO_LEG_DIVISIONS = ["Roofing", "Siding", "Roofing + Siding"];

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, " "));


// ── Division matching (raw JobProgress Division → operating bucket) ──
// Maps ACR division names (e.g. "ACR Roofing Division") and canonical trade strings
// to the operating buckets: Roofing, Siding, Roofing + Siding, Commercial, Repairs, Misc, Insurance, Non-Sales.
function classifyByDivision(rawDivision) {
  const d = norm(rawDivision);
  if (!d) return null;
  if (d.includes("insurance")) return "Insurance";
  // Combined Roofing + Siding — check before individual roof/siding
  if ((d.includes("roof") || d.includes("roofing")) && (d.includes("siding") || d.includes("side only")))
    return "Roofing + Siding";
  if (d.includes("commercial")) return "Commercial";
  if (d.includes("service") || d.includes("repair")) return "Repairs";
  if (d.includes("siding")) return "Siding";
  if (d.includes("roof")) return "Roofing";
  if (d.includes("window") || d.includes("gutter") || d.includes("door") || d.includes("mason")) return "Misc";
  if (d.includes("misc") || d.includes("remodel")) return "Misc";
  if (d.includes("warranty") || d.includes("callback")) return "Non-Sales";
  return null;
}

// ── Title fallback (when Division is missing) ──
function classifyByTitle(rawTitle) {
  const t = norm(rawTitle);
  if (!t) return null;
  // Non-sales exclusions first — one shared definition (nonSalesActivity.js).
  if (isNonSalesTitle(rawTitle)) return "Non-Sales";
  // Combined Roofing + Siding — check before individual roof/siding
  if ((t.includes("roof") || t.includes("roofing")) && (t.includes("siding") || t.includes("side")))
    return "Roofing + Siding";
  if (t.includes("commercial") || t.includes("comm ")) return "Commercial";
  if (t.includes("repair") || t.includes("service")) return "Repairs";
  if (t.includes("siding")) return "Siding";
  if (t.includes("roof")) return "Roofing";
  if (t.includes("window") || t.includes("gutter") || t.includes("door")) return "Misc";
  if (t.includes("misc")) return "Misc";
  return null;
}

// Detect title-like values — these are NOT genuine Division data.
// Titles contain EST, colons, address/client slash format, or match the raw appointment title.
function isTitleLike(value, rawTitle) {
  const v = norm(value);
  if (!v) return false;
  if (/\best\b/.test(v)) return true;                          // EST marker
  if (v.includes(":")) return true;                             // Colon format (ROOF EST: address/client)
  if (v.includes("/") && !v.includes("division")) return true;  // Address/client slashes
  if (rawTitle && v === norm(rawTitle)) return true;            // Matches raw title
  return false;
}

/**
 * Classify an appointment or debrief into a reporting division (operating bucket).
 * Priority: Insurance override → genuine JobProgress Division → Appointment title fallback.
 * Never overwrites raw source fields — read-only derivation.
 *
 * @param {Object} record — Appointment or Debrief with: product, business_division, trade, title
 * @returns {{ reporting_division, two_leg_eligible, classification_source, classification_conflict, conflict_reason }}
 */
export function classifyAppointment(record) {
  if (!record) return empty();

  const rawDivision = record.product || "";
  const businessDivision = record.business_division || "";
  const title = record.title || "";

  // A. Insurance override first
  if (businessDivision === "Insurance" || norm(rawDivision).includes("insurance")) {
    return { reporting_division: "Insurance", two_leg_eligible: false, classification_source: "Insurance Override", classification_conflict: false, conflict_reason: "" };
  }

  // B. Raw Division — only when it's a genuine Division, not a title
  let divisionBucket = null;
  if (rawDivision && !isTitleLike(rawDivision, title)) {
    divisionBucket = classifyByDivision(rawDivision);
  }

  if (divisionBucket) {
    let conflict = false, reason = "";
    if (title) {
      const titleBucket = classifyByTitle(title);
      if (titleBucket && titleBucket !== divisionBucket && titleBucket !== "Non-Sales") {
        conflict = true;
        reason = `Division: ${divisionBucket} vs Title: ${titleBucket}`;
      }
    }
    return {
      reporting_division: divisionBucket,
      two_leg_eligible: TWO_LEG_DIVISIONS.includes(divisionBucket),
      classification_source: "JobProgress Division",
      classification_conflict: conflict,
      conflict_reason: reason,
    };
  }

  // C. Appointment title fallback when Division is missing, title-like, or unclassifiable
  const fallbackTitle = title || (isTitleLike(rawDivision, "") ? rawDivision : "");
  if (fallbackTitle) {
    const titleBucket = classifyByTitle(fallbackTitle);
    if (titleBucket) {
      return {
        reporting_division: titleBucket,
        two_leg_eligible: TWO_LEG_DIVISIONS.includes(titleBucket),
        classification_source: "Appointment Title Fallback",
        classification_conflict: false,
        conflict_reason: "",
      };
    }
  }

  return empty();
}

function empty() {
  return { reporting_division: "Unclassified", two_leg_eligible: false, classification_source: "Unclassified", classification_conflict: false, conflict_reason: "" };
}

/**
 * Compact classification counts for dashboard display (operating buckets).
 */
export function classificationCounts(debriefs) {
  const ds = debriefs || [];
  const counts = {
    roofing: 0, siding: 0, roofingSiding: 0, commercial: 0, repairs: 0, misc: 0,
    insurance: 0, nonSales: 0, unclassified: 0, conflicts: 0,
  };
  ds.forEach((d) => {
    const c = classifyAppointment(d);
    switch (c.reporting_division) {
      case "Roofing": counts.roofing++; break;
      case "Siding": counts.siding++; break;
      case "Roofing + Siding": counts.roofingSiding++; break;
      case "Commercial": counts.commercial++; break;
      case "Repairs": counts.repairs++; break;
      case "Misc": counts.misc++; break;
      case "Insurance": counts.insurance++; break;
      case "Non-Sales": counts.nonSales++; break;
      default: counts.unclassified++; break;
    }
    if (c.classification_conflict) counts.conflicts++;
  });
  return counts;
}

/**
 * Enrich debriefs with the linked appointment's title AND product (JP Division).
 * Allows the classifier to use the JP Division for debriefs that have a blank product.
 * Non-destructive: adds fields only when the debrief doesn't already have them.
 */
export function enrichDebriefsWithTitles(debriefs, appointments) {
  const titleMap = {};
  const productMap = {};
  (appointments || []).forEach((a) => {
    if (a.crm_lead_id) {
      titleMap[a.crm_lead_id.toLowerCase()] = a.title || "";
      productMap[a.crm_lead_id.toLowerCase()] = a.product || "";
    }
  });
  return (debriefs || []).map((d) => ({
    ...d,
    title: d.title || titleMap[(d.crm_lead_id || "").toLowerCase()] || "",
    product: d.product || productMap[(d.crm_lead_id || "").toLowerCase()] || "",
  }));
}

/**
 * Returns the display value for the Raw Division field in detail views.
 * Title-like values are not genuine Division data — show "—" or "Not provided in appointment export".
 */
export function getRawDivisionDisplay(record, short = false) {
  if (!record) return "—";
  const rawDivision = record.product || "";
  if (!rawDivision) return "—";
  if (isTitleLike(rawDivision, record.title || "")) return short ? "—" : "Not provided in appointment export";
  return rawDivision;
}