export const PRODUCTS = [
  "Roofing","Siding","Gutters","Windows","Doors","Masonry","Chimney",
  "Skylight","Solar R&R","Repair","Maintenance","Commercial Roofing","Insurance","Other"
];

export const TRADES = [
  "Roofing","Siding","Gutters","Windows","Doors","Chimney","Masonry","Other"
];

export const INSURANCE_OUTCOMES = [
  "Demo Completed","No Damage","Reset Needed","No See/Cancelled","DQ","Pending"
];

export const APPOINTMENT_OUTCOMES = [
  "Demo Completed — Sale",
  "Demo Completed — Demo No Sale",
  "Demo Completed — Sale / Credit Decline",
  "Demo Completed — Sale / Cancellation",
  "No Demo — Reset Needed",
  "No Demo — Do Not Reset",
  "No C / No Show — Reset Needed",
  "No C / No Show — Do Not Reset",
  "Cancelled Before Appointment",
  "Rescheduled Before Appointment",
  "Pending / Not Updated",
  "DQ — Disqualified",
  "Estimating in Progress — Proposal Not Yet Sent"
];

export const APPOINTMENT_TYPES = [
  "First Appointment",
  "Reset Demo",
  "Reset No See",
  "Rehash",
  "Follow-Up"
];

// Help text for the Appointment Type field on the debrief form.
export const APPOINTMENT_TYPE_HELP_TEXT =
  "First Appointment = original sales visit; Reset Demo = rescheduled visit after no demo; Rehash = older unsold lead worked and booked again.";

export const DECISION_MAKER_STATUS = ["Two-Leg","One-Leg","N/A"];

export const SALE_CLOSE_TYPES = [
  "No Sale","First Call Close","Rehash Close","Follow-Up Close",
  "Reset Close","Sale After Follow-Up","Credit Decline","Cancellation","Pending","Not Applicable"
];

export const FINANCING_RESULTS = [
  "Not Offered","Offered — Not Used","Approved","Credit Declined",
  "Pending","Cancelled After Approval","Other"
];

export const RESET_STATUSES = [
  "Reset Demo Performed","Reset No Demo","Reset No C","Do Not Reset","Not Reset"
];

export const FOLLOW_UP_BUCKETS = [
  "Hot Follow-Up","Warm Follow-Up","Cold Follow-Up","Future Follow-Up",
  "Rehash","Existing Client Follow-Up","Dead","Won","Pending"
];

export const MAIN_OBJECTIONS = [
  "Price","Timing","Spouse / Decision Maker","Financing",
  "Wants More Estimates","Insurance","Trust / Reviews",
  "Scope Confusion","Not Ready","Other"
];

export const CANCELLATION_REASONS = [
  "Price","Found Cheaper Contractor","Financing Fell Through",
  "Spouse / Decision Maker","Changed Mind","Scope Change","Timing","Other"
];

export const DEBRIEF_STATUSES = ["Missing","Submitted","Needs Review","Approved","Unmatched"];
export const APPOINTMENT_STATUSES = ["Set","Completed","Cancelled","Rescheduled","No Show","Invalid","Duplicate","Pending"];

// Outcome groupings for KPI logic
export const SALE_OUTCOMES = [
  "Demo Completed — Sale",
  "Demo Completed — Sale / Credit Decline",
  "Demo Completed — Sale / Cancellation"
];

export const DEMO_OUTCOMES = [
  "Demo Completed — Sale",
  "Demo Completed — Demo No Sale",
  "Demo Completed — Sale / Credit Decline",
  "Demo Completed — Sale / Cancellation"
];

export const NON_COMPLETED_OUTCOMES = [
  "Cancelled Before Appointment",
  "Rescheduled Before Appointment",
  "Pending / Not Updated"
];

export const RESET_OUTCOMES = [
  "No Demo — Reset Needed",
  "No C / No Show — Reset Needed"
];

export const DEMO_NO_SALE_OUTCOME = "Demo Completed — Demo No Sale";
export const SALE_CREDIT_DECLINE_OUTCOME = "Demo Completed — Sale / Credit Decline";
export const SALE_CANCELLATION_OUTCOME = "Demo Completed — Sale / Cancellation";
export const DQ_OUTCOME = "DQ — Disqualified";
export const ESTIMATING_IN_PROGRESS_OUTCOME = "Estimating in Progress — Proposal Not Yet Sent";

export const FIRST_CALL_CLOSE = "First Call Close";
export const CREDIT_DECLINE_CLOSE = "Credit Decline";
export const CANCELLATION_CLOSE = "Cancellation";

// The single source of truth for account roles. Adding one here is only the
// first step — the database CHECK constraint on app_user.role and the
// allied_is_authenticated() RLS helper enumerate them too (see migrations
// 0002/0004, extended by 0011) and must move in lockstep.
export const ROLE_LABELS = {
  admin: "Admin / Owner",
  sales_manager: "Sales Manager",
  project_manager: "Project Manager",
  production: "Production (schedule only)",
  appointment_setter: "Appointment Setter",
  inside_sales_rep: "Inside Sales Rep",
  outside_sales_rep: "Outside Sales Rep",
  view_only: "View Only",
  user: "User"
};
export const ROLES = Object.keys(ROLE_LABELS);
// Who sees the production schedule board (customer addresses on a map). The
// database enforces the same list in allied_is_production() (migration 0012).
export const PRODUCTION_ROLES = ["admin", "sales_manager", "project_manager", "production"];
// `production` is production-ONLY: the schedule board and their own account,
// no sales pages or data. Every other role is sales-side staff. The database
// enforces the same split in allied_is_authenticated() (migration 0013).
export const STAFF_ROLES = ROLES.filter((r) => r !== "production");
export const isProductionOnly = (role) => role === "production";

export const DATE_FILTERS = ["Today","Yesterday","This Week","This Month","Last Month","Last Quarter","This Quarter","Year to Date","Custom Range"];

// Admin Settings list manager categories
export const LIST_CATEGORIES = [
  { key: "sales_rep", label: "Sales Reps" },
  { key: "appointment_setter", label: "Appointment Setters / Call Center Reps" },
  { key: "marketing_source", label: "Marketing Sources" },
  { key: "referral_source", label: "Referral Sources" },
  { key: "product", label: "Divisions" },
  { key: "appointment_type", label: "Appointment Types" },
  { key: "appointment_outcome", label: "Appointment Outcomes" },
  { key: "sale_close_type", label: "Close Types" },
  { key: "financing_result", label: "Financing Results" },
  { key: "main_objection", label: "Objection Types" },
  { key: "cancellation_reason", label: "Cancellation Reasons" },
  { key: "follow_up_bucket", label: "Follow-Up Buckets" },
  { key: "decision_maker_status", label: "Decision Maker Status" },
  { key: "reset_status", label: "Reset Statuses" },
  { key: "submitted_by", label: "Submitted By Names" }
];

// Seed data for each category
// Active roster — shown in new-debrief dropdowns (ComboSelect reads ListOption records,
// these are the canonical seed values). Historical/inactive people are kept in the
// HISTORICAL_* constants below so they can still appear in filters/reports when records exist.
export const ACTIVE_SALES_REPS = ["Jason Malarchak","Michael","Pema Sherpa","Other"];
export const ACTIVE_SETTERS = ["Ashley Pasquale","Vanessa","Angelo","Arrie","Cherrie","Other"];
// Historical people — not in the active new-debrief dropdown, but retained for historical filters/reports.
export const HISTORICAL_SALES_REPS = ["Pete"];
export const HISTORICAL_SETTERS = ["Sebastian","Mario"];
// Alias -> canonical name proposals (awaiting approval before any data normalization).
export const SETTER_ALIASES = { "Ashley": "Ashley Pasquale", "Ashley Pascual": "Ashley Pasquale" };
export const REP_ALIASES = { "Pema": "Pema Sherpa", "Jason": "Jason Malarchak" };

export const SEED_OPTIONS = {
  sales_rep: ACTIVE_SALES_REPS,
  appointment_setter: ACTIVE_SETTERS,
  appointment_type: APPOINTMENT_TYPES,
  decision_maker_status: ["Two-Leg","One-Leg","N/A"],
  product: PRODUCTS,
  appointment_outcome: APPOINTMENT_OUTCOMES,
  sale_close_type: SALE_CLOSE_TYPES,
  financing_result: FINANCING_RESULTS,
  reset_status: RESET_STATUSES,
  follow_up_bucket: FOLLOW_UP_BUCKETS,
  main_objection: MAIN_OBJECTIONS,
  cancellation_reason: CANCELLATION_REASONS,
  submitted_by: ["Jason Malarchak","Michael","Pema Sherpa","Ashley Pasquale","Vanessa","Angelo","Arrie","Cherrie"]
};

export function inDateRange(dateStr, filter, customStart, customEnd) {
  if (!dateStr) return false;
  const d = new Date(dateStr + "T00:00:00");
  if (isNaN(d.getTime())) return false;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startToday = today.getTime();
  const endToday = startToday + 86400000;
  const qIdx = Math.floor(today.getMonth() / 3);
  switch (filter) {
    case "Today": return d.getTime() >= startToday && d.getTime() < endToday;
    case "Yesterday": { const s = startToday - 86400000; return d.getTime() >= s && d.getTime() < startToday; }
    case "This Week": { const day = (today.getDay() + 6) % 7; const ws = startToday - day * 86400000; return d.getTime() >= ws && d.getTime() < ws + 7 * 86400000; }
    case "This Month": return d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
    case "Last Month": { const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); return d.getFullYear() === lm.getFullYear() && d.getMonth() === lm.getMonth(); }
    case "This Quarter": { const qs = new Date(today.getFullYear(), qIdx * 3, 1).getTime(); return d.getTime() >= qs && d.getTime() < endToday; }
    case "Last Quarter": { const lqStart = new Date(today.getFullYear(), (qIdx - 1) * 3, 1).getTime(); const lqEnd = new Date(today.getFullYear(), qIdx * 3, 1).getTime(); return d.getTime() >= lqStart && d.getTime() < lqEnd; }
    case "Year to Date": { const ys = new Date(today.getFullYear(), 0, 1).getTime(); return d.getTime() >= ys && d.getTime() < endToday; }
    case "Custom Range": {
      if (customStart) { const s = new Date(customStart + "T00:00:00").getTime(); if (d.getTime() < s) return false; }
      if (customEnd) { const e = new Date(customEnd + "T00:00:00").getTime() + 86400000; if (d.getTime() >= e) return false; }
      return true;
    }
    default: return true;
  }
}

function fmtLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getDateRangeBounds(filter, customStart, customEnd) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const qIdx = Math.floor(today.getMonth() / 3);
  const fmt = (d) => fmtLocal(d);
  switch (filter) {
    case "Today": return { start: fmt(today), end: fmt(today) };
    case "Yesterday": { const y = new Date(today); y.setDate(today.getDate() - 1); return { start: fmt(y), end: fmt(y) }; }
    case "This Week": { const day = (today.getDay() + 6) % 7; const ws = new Date(today); ws.setDate(today.getDate() - day); return { start: fmt(ws), end: fmt(today) }; }
    case "This Month": return { start: fmt(new Date(today.getFullYear(), today.getMonth(), 1)), end: fmt(today) };
    case "Last Month": { const lm = new Date(today.getFullYear(), today.getMonth() - 1, 1); const lme = new Date(today.getFullYear(), today.getMonth(), 0); return { start: fmt(lm), end: fmt(lme) }; }
    case "This Quarter": return { start: fmt(new Date(today.getFullYear(), qIdx * 3, 1)), end: fmt(today) };
    case "Last Quarter": { const lqs = new Date(today.getFullYear(), (qIdx - 1) * 3, 1); const lqe = new Date(today.getFullYear(), qIdx * 3, 0); return { start: fmt(lqs), end: fmt(lqe) }; }
    case "Year to Date": return { start: fmt(new Date(today.getFullYear(), 0, 1)), end: fmt(today) };
    case "Custom Range": return { start: customStart || "", end: customEnd || "" };
    default: return null;
  }
}