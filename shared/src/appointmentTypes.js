// Canonical appointment-type labels and normalization.
// Shared across import, save, display, and KPI calculation boundaries so that
// legacy/variant values never create duplicate selectable labels or split KPIs.

export const APPT_TYPE_FIRST = "First Appointment";
export const APPT_TYPE_RESET_DEMO = "Reset Demo";
export const APPT_TYPE_REHASH = "Rehash";

// Canonical selectable labels (what users see / choose).
export const CANONICAL_APPOINTMENT_TYPES = [
  APPT_TYPE_FIRST,
  APPT_TYPE_RESET_DEMO,
  "Reset No See",
  APPT_TYPE_REHASH,
  "Follow-Up",
];

// Legacy / variant -> canonical mapping (case-insensitive lookup).
const NORMALIZE_MAP = {
  "first appointment": APPT_TYPE_FIRST,
  "new appointment": APPT_TYPE_FIRST,
  "first appt": APPT_TYPE_FIRST,
  "reset demo": APPT_TYPE_RESET_DEMO,
  "rehash": APPT_TYPE_REHASH,
  "re-engagement": APPT_TYPE_REHASH,
  "re engagement": APPT_TYPE_REHASH,
  "reengagement": APPT_TYPE_REHASH,
  "re hash": APPT_TYPE_REHASH,
};

/**
 * Normalize a raw appointment-type value to its canonical label.
 * Returns "" for empty input. Unknown values pass through unchanged
 * (so future labels are not silently dropped).
 */
export function normalizeAppointmentType(raw) {
  if (!raw) return "";
  const key = String(raw).trim().toLowerCase().replace(/\s+/g, " ");
  return NORMALIZE_MAP[key] || String(raw).trim();
}

// Concise help text for the debrief form.
export const APPOINTMENT_TYPE_HELP = {
  [APPT_TYPE_FIRST]: "Original sales visit.",
  [APPT_TYPE_RESET_DEMO]: "Rescheduled visit after no demo on the original appointment.",
  [APPT_TYPE_REHASH]: "Older unsold lead worked and booked again.",
};

export const APPOINTMENT_TYPE_HELP_TEXT =
  "First Appointment = original sales visit; Reset Demo = rescheduled visit after no demo; Rehash = older unsold lead worked and booked again.";