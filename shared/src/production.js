// Production schedule rules shared by the backend sync and the schedule board.
//
// JobProgress schedule titles follow the office's own convention:
//   "RR: Randolph/6 Meadow Lark Court/RR/Joseph Lorent"
//   "GUTTERS: West Orange/29 Carter Rd/SR/George Golab"
//   "SHED: Janet Dixon / Job # 2025-100618"
// i.e. a job-type CODE before the colon, then slash-separated parts that are
// usually town / street / (code again) / customer. The trades include on the
// API is mostly empty, so the code is the reliable signal for pin colours.
//
// Shared-package rules: framework-free, environment-free, imports nothing.

export const JOB_TYPE_LABELS = {
  "RR": "Roof Replacement",
  "SR": "Siding Replacement",
  "RR+SR": "Roof + Siding",
  "GUTTERS": "Gutters",
  "WR": "Windows",
  "MS": "Misc / Service",
  "MS REPAIR": "Misc Repair",
  "MS-CB": "Callback",
  "CB": "Callback",
  "SHED": "Shed",
  "SOLAR": "Solar",
};

/** Stable colours per job type, chosen to stay distinct on a map. */
export const JOB_TYPE_COLORS = {
  "RR": "#1d4ed8",        // blue
  "SR": "#7c3aed",        // violet
  "RR+SR": "#0f766e",     // teal
  "GUTTERS": "#ca8a04",   // amber
  "WR": "#db2777",        // pink
  "MS": "#57534e",        // stone
  "MS REPAIR": "#57534e",
  "MS-CB": "#ea580c",     // orange
  "CB": "#ea580c",
  "SHED": "#65a30d",      // lime
  "SOLAR": "#0891b2",     // cyan
};
export const DEFAULT_TYPE_COLOR = "#334155";

const norm = (s) => (s == null ? "" : String(s).trim());

/**
 * Splits a schedule title into its parts. Everything is best-effort: a title
 * that does not follow the convention yields `code: null` and the raw title as
 * `summary`, never a throw.
 */
export function parseScheduleTitle(title) {
  const raw = norm(title);
  if (!raw) return { code: null, label: "Unknown", town: null, address: null, customer: null, summary: "" };

  const colon = raw.indexOf(":");
  let code = null;
  let rest = raw;
  if (colon > 0 && colon <= 12) {
    code = raw.slice(0, colon).trim().toUpperCase().replace(/\s+/g, " ");
    rest = raw.slice(colon + 1).trim();
  }

  const parts = rest.split("/").map((p) => p.trim()).filter(Boolean);
  // Drop a repeated code segment ("…/RR/…") so it is not mistaken for a name.
  const meaningful = parts.filter((p) => !(code && p.toUpperCase() === code) && !/^(RR|SR|WR|CB|MS)$/i.test(p));

  const town = meaningful.length >= 2 ? meaningful[0] : null;
  const address = meaningful.length >= 2 ? meaningful[1] : null;
  const customer = meaningful.length >= 3 ? meaningful[meaningful.length - 1]
    : meaningful.length === 1 ? meaningful[0] : null;

  return {
    code,
    label: (code && JOB_TYPE_LABELS[code]) || code || "Other",
    town, address, customer,
    summary: rest,
  };
}

export function jobTypeColor(code) {
  return (code && JOB_TYPE_COLORS[code]) || DEFAULT_TYPE_COLOR;
}

/**
 * The board's three states. "unassigned" is the actionable one: a scheduled
 * install with no crew on it.
 */
export function scheduleStatus(item) {
  if (item.is_completed === true || item.isCompleted === true) return "completed";
  const crews = item.crews ?? item.crew_names ?? [];
  return Array.isArray(crews) && crews.length > 0 ? "assigned" : "unassigned";
}

export const STATUS_LABELS = {
  assigned: "Assigned",
  unassigned: "No crew assigned",
  completed: "Completed",
};
