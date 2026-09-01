// Sales-appointment eligibility for JobProgress imports.
// A single reusable classifier used by the import function, dashboards, and the Appointment Records UI.

import { isNonSalesTitle, nonSalesKeyword, normalizeTitle as norm } from "./nonSalesActivity.js";


/**
 * Classify whether a JobProgress appointment is a sales appointment.
 *
 * Sales-eligible only when the title contains the standalone token EST (case-insensitive),
 * e.g. ROOF EST, REPAIR EST, SIDING EST, ROOF & SIDING EST, MISC EST, REHASH ROOF EST,
 * DEMO ROOF EST, NO SEE ... EST.
 *
 * ESTIMATING is NOT treated as the EST code. Warranty Callback/WCB, Sample, Walk Thru/Through,
 * Customer Service, Solar, and Unassigned are always excluded even if EST appears elsewhere.
 * A blank/No See/No Demo/Sale Appointment Result does NOT disqualify a real EST appointment.
 *
 * @param {string} title  - The appointment title from JobProgress
 * @param {string} [division] - Optional division/product (reserved, does not override title logic)
 * @returns {{ isSales: boolean, reason: string|null }}
 */
export function classifySalesAppointment(title, division) {
  const raw = (s) => (s == null ? "" : String(s).trim());
  const t = norm(title);
  if (!t) return { isSales: false, reason: "Unassigned — no title" };

  // 1. Non-sales activity takes priority over EST: "WARRANTY ROOF EST" is a
  //    service visit that happens to carry the estimate code.
  if (isNonSalesTitle(title)) {
    return { isSales: false, reason: `Excluded — ${raw(title) || nonSalesKeyword(title)}` };
  }

  // 2. Standalone EST token. \best\b does NOT match inside "estimating" because
  //    the char after "est" is a word char (no word boundary). Punctuation/space
  //    before or after EST creates a valid boundary.
  if (/\best\b/.test(t)) {
    return { isSales: true, reason: null };
  }

  return { isSales: false, reason: `Non-EST — ${raw(title) || "untitled"}` };
}

/**
 * Filter an appointments list to sales appointments only.
 * Records where is_sales_appointment is explicitly false are excluded.
 * Records where the field is unset (null/undefined — historical) are kept.
 */
export function salesAppointmentsOnly(appointments) {
  return (appointments || []).filter((a) => a.is_sales_appointment !== false);
}

/**
 * Canonical identity key for an appointment: normalized external Job ID/CRM Lead ID
 * + appointment date + start time. Same Job ID on a different date/time is a separate
 * appointment (rehash/reset/follow-up).
 */
export function canonicalAppointmentKey(crmLeadId, appointmentDate, appointmentTime) {
  const id = norm(crmLeadId);
  const date = (appointmentDate || "").trim();
  const time = norm(appointmentTime);
  return `${id}|${date}|${time}`;
}