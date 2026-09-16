// The top of the Overview funnel: leads, and what became of the ones that
// never got an appointment.
//
// In JobProgress a lead IS a job — the workflow begins at "LEAD NOT
// CONTACTED!!!" — and a lead's fate is the stage its job sits in. The buckets
// below are the office's own stage names grouped the way the executive reads
// them; nothing here is inferred from anything but the stage.
//
// "Appointment set" is decided by whether a sales appointment exists for the
// job, never by the stage name, so it always agrees with the funnel beneath it.

import { stageKey } from "./jobStages.js";

/** In display order. `stages` are matched by normalised name (stageKey). */
export const LEAD_REASONS = [
  { key: "dq", label: "Disqualified", stages: ["DQ (MGR APPROVAL)", "Disqualified Lead"] },
  { key: "working", label: "Still being worked",
    stages: ["LEAD NOT CONTACTED!!!", "CONTACTED NEEDS FOLLOW UP!!!", "Need to Confirm Appointment", "Appointment Set"] },
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
 * @param {Array<{ current_stage?: string|null, has_appointment: boolean }>} rows
 *   Jobs created in the range, insurance already excluded.
 * @returns {{ leads, set, notSet, setRate, notSetRate, reasons: Array<{key,label,count,share}> }}
 *   `share` is of NOT SET, so the reasons add up to the box above them.
 */
export function leadFlow(rows) {
  const all = rows ?? [];
  const set = all.filter((r) => r.has_appointment === true).length;
  const notSetRows = all.filter((r) => r.has_appointment !== true);
  const counts = Object.fromEntries(LEAD_REASONS.map((r) => [r.key, 0]));
  for (const r of notSetRows) counts[leadReason(r.current_stage)]++;
  const notSet = notSetRows.length;
  return {
    leads: all.length, set, notSet,
    setRate: pct(set, all.length), notSetRate: pct(notSet, all.length),
    reasons: LEAD_REASONS.map((r) => ({ key: r.key, label: r.label, count: counts[r.key], share: pct(counts[r.key], notSet) })),
  };
}
