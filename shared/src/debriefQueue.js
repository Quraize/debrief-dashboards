// Open Debrief Queue: which appointments still need a debrief, and what the
// CRM already knows about each one.
//
// The queue lists rows from the `appointment` table (the operational matching
// table). Each row is joined here — in memory, on the client — to its CRM
// mirror: jp_appointment (result form, Two-Leg, booking), jp_customer (lead
// source, call-center rep) and jp_job (stage, contract value). The join key is
// the KPI engine's own: Lead ID + appointment date.
//
// "Needs a debrief" follows the sales dashboard's run rule: an appointment the
// CRM says was a No See, was cancelled, or never got a result form is not a
// missing debrief — there was nothing to debrief. Those are reported in their
// own view, never silently dropped.

import {
  isRunAppointment, isNoShowResult, isCancelledTitle, classifyNoResult, isResetTitle, isRehashTitle,
  isSaleResult, isDemoNoSaleResult, jobTypeFromDivision,
} from "./jpStats.js";
import { jpLeadSource } from "./jpMarketing.js";

/** YYYY-MM-DD of `now` on the viewer's clock (the office runs the queue). */
export function localDay(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Lead ID + date key, the same normalization the KPI engine and the queue use. */
export function crmKey(leadId, date) {
  if (!leadId || !date) return null;
  return String(leadId).toLowerCase().trim() + "|" + String(date).slice(0, 10);
}

/**
 * Index CRM appointments by Lead ID + date. When the CRM holds two entries for
 * the same job on the same day (a rebooked time slot), the one with a result
 * form wins — it is the one that describes what happened.
 */
export function indexJpAppointments(jpRows) {
  const byKey = new Map();
  for (const r of jpRows || []) {
    const key = crmKey(r.crm_lead_id, r.appointment_date);
    if (!key) continue;
    const prev = byKey.get(key);
    if (!prev || (r.has_result === true && prev.has_result !== true)) byKey.set(key, r);
  }
  return byKey;
}

/**
 * Every way a debrief can point at an appointment, indexed once:
 *   - the appointment row's id (set when the form matched at submit time)
 *   - the JobProgress appointment id (the form's own duplicate check)
 *   - Lead ID + date (the KPI engine's rule) — ONLY for debriefs that carry
 *     neither of the two exact links (spreadsheet imports, hand-typed forms).
 * A lead often has several appointments (first visit, reset demo, sometimes
 * two on one day). A debrief pinned to one visit must not cover its siblings,
 * so the exact links win and the per-day rule is the fallback.
 * The queue, the reminder job and the sync's reconcile all apply the same rule.
 */
export function debriefIndex(debriefs) {
  const byLeadDate = new Set();
  const byAppointmentId = new Set();
  const byRecordId = new Set();
  for (const d of debriefs || []) {
    const rid = String(d.appointment_record_id ?? "").trim().toLowerCase();
    const linked = !!d.appointment_id || !!rid;
    if (d.appointment_id) byAppointmentId.add(String(d.appointment_id));
    if (rid) byRecordId.add(rid);
    if (!linked) { const k = crmKey(d.crm_lead_id, d.appointment_date); if (k) byLeadDate.add(k); }
  }
  return { byLeadDate, byAppointmentId, byRecordId };
}

/** Whether an appointment row has a debrief, by status or by any link in the index. */
export function hasDebriefFor(appt, index) {
  if (!appt) return false;
  if (appt.debrief_status === "Submitted" || appt.debrief_status === "Approved") return true;
  if (!index) return false;
  const k = crmKey(appt.crm_lead_id, appt.appointment_date);
  if (k && index.byLeadDate.has(k)) return true;
  if (appt.id && index.byAppointmentId.has(String(appt.id))) return true;
  const rid = String(appt.appointment_record_id ?? "").trim().toLowerCase();
  return !!rid && index.byRecordId.has(rid);
}

export function indexById(rows, idField) {
  const m = new Map();
  for (const r of rows || []) if (r[idField] != null) m.set(String(r[idField]), r);
  return m;
}

/** Deep link to the job in JobProgress, when both ids are known. */
export function jobProgressJobUrl(customerId, jobId) {
  if (!customerId || !jobId) return null;
  return `https://app.jobprogress.com/#/customer-jobs/${encodeURIComponent(customerId)}/job/${encodeURIComponent(jobId)}/overview`;
}

/**
 * What the CRM says happened at this appointment.
 *   run        — result recorded, the rep met the customer → a debrief is due
 *   awaiting   — no result yet, appointment within the last 14 days → still due
 *   no_see     — customer did not show
 *   cancelled  — title marked CANCELLED
 *   no_result  — no result after 14 days; treated as never run
 *   upcoming   — has not happened yet
 */
export function crmStatus(jp, now = new Date()) {
  if (!jp) return null;
  if (jp.has_result === true) return isNoShowResult(jp) ? "no_see" : "run";
  return classifyNoResult(jp, now);
}

export const CRM_STATUS_LABELS = {
  run: "Run", awaiting: "Awaiting CRM result", no_see: "No See", cancelled: "Cancelled",
  no_result: "No CRM result", upcoming: "Upcoming",
};

/** Statuses that take an appointment OUT of the missing-debrief queue. */
export const EXCLUDED_CRM_STATUSES = new Set(["no_see", "cancelled", "no_result"]);

/**
 * Everything the card can show beyond the appointment row itself.
 * @returns {{ crm: object|null, lead: object|null, job: object|null, daysSince: number|null }}
 */
export function enrichQueueItem(appt, { jpByKey, customersById, jobsById }, now = new Date()) {
  const jp = jpByKey?.get(crmKey(appt.crm_lead_id, appt.appointment_date)) ?? null;
  const customerId = jp?.jp_customer_id != null ? String(jp.jp_customer_id) : null;
  const jobId = (jp?.crm_job_id ?? appt.crm_job_id) != null ? String(jp?.crm_job_id ?? appt.crm_job_id) : null;
  const customer = customerId ? customersById?.get(customerId) ?? null : null;
  const job = jobId ? jobsById?.get(jobId) ?? null : null;

  const crm = jp ? {
    status: crmStatus(jp, now),
    result: jp.result_option_name || null,
    isSale: isSaleResult(jp),
    isDemo: isSaleResult(jp) || isDemoNoSaleResult(jp),
    twoLeg: jp.two_leg_answer || null,
    twoLegRaw: jp.two_leg_raw || null,
    jobType: jobTypeFromDivision(jp.division),
    division: jp.division || null,
    salesRep: jp.sales_rep || null,
    setter: jp.appointment_setter || null,
    bookedAt: jp.jp_created_at || null,
    isReset: isResetTitle(jp),
    isRehash: isRehashTitle(jp),
    isInsurance: jp.is_insurance === true,
    title: jp.title || null,
    jpUrl: jobProgressJobUrl(customerId, jobId),
  } : null;

  const lead = customer ? {
    ...jpLeadSource(customer),
    callCenterRep: customer.call_center_rep || null,
    canvasser: customer.canvasser || null,
    createdAt: customer.jp_created_at || null,
  } : null;

  const price = job ? Number(job.total_job_price ?? job.total_job_revenue) : NaN;
  const jobInfo = job ? {
    jobNumber: job.job_number || null,
    stage: job.current_stage || null,
    stageColor: job.stage_color || null,
    signedDate: job.contract_signed_date ? String(job.contract_signed_date).slice(0, 10) : null,
    price: Number.isFinite(price) && price > 0 ? price : null,
  } : null;

  return { crm, lead, job: jobInfo, daysSince: daysSince(appt.appointment_date, now) };
}

/** Whole days from the appointment date to now; null for missing/future dates. */
export function daysSince(date, now = new Date()) {
  const d = String(date ?? "").slice(0, 10);
  if (!d) return null;
  const diff = Math.floor((Date.parse(`${localDay(now)}T00:00:00`) - Date.parse(`${d}T00:00:00`)) / 86_400_000);
  return diff >= 0 ? diff : null;
}

/** Whole days from now until the appointment; null for missing/past dates. */
export function daysUntil(date, now = new Date()) {
  const d = String(date ?? "").slice(0, 10);
  if (!d) return null;
  const diff = Math.floor((Date.parse(`${d}T00:00:00`) - Date.parse(`${localDay(now)}T00:00:00`)) / 86_400_000);
  return diff > 0 ? diff : null;
}

/**
 * How long after an appointment starts before a missing debrief is worth
 * chasing. Matches DEBRIEF_REMINDER_DELAY_HOURS so the queue and the reminder
 * emails agree: without it a 2pm appointment is listed as missing from
 * midnight, and managers see this morning's work flagged before it happens.
 */
export const MISSING_GRACE_HOURS = 2;

/** Minutes past midnight for "14:00" or "2:00 PM"; null when unparseable. */
function minutesOfDay(raw) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase().replace(/\./g, "");
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  return h > 23 || min > 59 ? null : h * 60 + min;
}

/**
 * When this appointment has had enough time to happen — its start plus the
 * grace period. An appointment with no time on it falls back to midnight, so
 * it behaves as it always has and surfaces on its own day.
 */
export function debriefableAt(appt, graceHours = MISSING_GRACE_HOURS) {
  const date = String(appt?.appointment_date ?? "").slice(0, 10);
  if (!date) return null;
  const base = Date.parse(`${date}T00:00:00`);
  if (Number.isNaN(base)) return null;
  return new Date(base + (minutesOfDay(appt.appointment_time) ?? 0) * 60_000 + graceHours * 3_600_000);
}

/**
 * Leads whose appointment was moved in the last `days`: the old row is retired
 * and a live one took its place. Worth flagging on the board — a moved
 * appointment is the one most likely to catch a rep out.
 */
export function recentlyRescheduledLeads(appointments, now = new Date(), days = 3) {
  const since = now.getTime() - days * 86_400_000;
  const out = new Set();
  for (const a of appointments ?? []) {
    if (!a?.retired_at || !a.crm_lead_id) continue;
    const t = Date.parse(a.retired_at);
    if (Number.isFinite(t) && t >= since) out.add(String(a.crm_lead_id).toLowerCase().trim());
  }
  return out;
}

/**
 * Where a sales appointment stands, from the queue's point of view.
 *   missing   — happened (per the CRM, or the CRM has no record) and no debrief yet
 *   debriefed — a debrief exists
 *   excluded  — the CRM says it was a No See / cancelled / never got a result
 *   upcoming  — not yet, or not yet had time to happen
 */
export function queueDisposition(appt, crm, hasDebrief, now = new Date(), graceHours = MISSING_GRACE_HOURS) {
  const date = String(appt.appointment_date ?? "").slice(0, 10);
  if (!date) return "upcoming";
  // A debrief filed the moment the rep leaves settles it, grace period or not.
  if (hasDebrief) return "debriefed";
  const due = debriefableAt(appt, graceHours);
  if (due ? now.getTime() < due.getTime() : date > localDay(now)) return "upcoming";
  if (crm && EXCLUDED_CRM_STATUSES.has(crm.status)) return "excluded";
  const status = appt.debrief_status;
  return status === "Missing" || status === "Unmatched" ? "missing" : "other";
}

/** A missing debrief is overdue once the appointment is this many days old. */
export const OVERDUE_DAYS = 7;

/**
 * "Important" = the debriefs that cost the most if they stay missing: the CRM
 * recorded a SALE (revenue with no debrief behind it), or the appointment is a
 * week old or more and still has no debrief. Only applies to missing items.
 */
export function isImportant(item) {
  if (!item || item.disposition !== "missing") return false;
  if (item.crm?.isSale) return true;
  return item.daysSince != null && item.daysSince >= OVERDUE_DAYS;
}

// Re-exported so the page needs one import for the rules it applies.
export { isRunAppointment, isCancelledTitle };
