// JobProgress workflow stages, grouped the way the office's Jobs screen shows
// them (the API exposes stages, not the grouping).
//
// Matching is by stage NAME (normalised), because names are what the office
// recognises and codes are opaque. A stage that is not in any group is not
// tracked by the jobs board — the ~40 lead-pipeline and closed stages stay in
// the sales world.

export const STAGE_GROUPS = [
  {
    key: "project_won",
    label: "Project Won",
    color: "#7c3aed",
    stages: [
      "On Hold/Credit DQ (MGR APPR)",
      "Accepted/INS Claim Pending",
      "Accepted/No Deposit/Finance",
      "Install Accepted-> SUBMIT SS",
      "Repair Accepted-> SUBMIT SS",
      "Sales Review",
    ],
  },
  {
    key: "production",
    label: "Production",
    color: "#1d4ed8",
    stages: [
      "Production Review",
      "Approved New Installs",
      "Approved Service/Repairs",
      "Roof/Siding Scheduled",
      "Repairs Scheduled",
      "Remodel Scheduled",
      "Production Started",
      "Gutters/Solar/Punchlist",
      "Need Final Walk-Through",
      "City & Manufacturer Inspection",
      "COMPLETED NEED FINAL PAYMENT!!",
    ],
  },
  {
    key: "warranty",
    label: "Warranty Work",
    color: "#0891b2",
    stages: [
      "Open Warranty Claims/CallBacks",
      "Closed Warranty Claims",
    ],
  },
];

/** Tolerant of spacing, case, and the office's punctuation (“->”, “&”, “!!”). */
export function stageKey(name) {
  return String(name ?? "").toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9/&()>-]/g, "").trim();
}

const GROUP_BY_STAGE = new Map();
for (const g of STAGE_GROUPS) for (const s of g.stages) GROUP_BY_STAGE.set(stageKey(s), g);

/** The group a stage name belongs to, or null when the board does not track it. */
export function stageGroup(name) {
  return GROUP_BY_STAGE.get(stageKey(name)) ?? null;
}

export const isTrackedStage = (name) => stageGroup(name) !== null;

/** Position of a stage within its group (for ordering chips the way JobProgress does). */
export function stageOrder(name) {
  const g = stageGroup(name);
  if (!g) return 999;
  const k = stageKey(name);
  return STAGE_GROUPS.indexOf(g) * 100 + g.stages.findIndex((s) => stageKey(s) === k);
}

/** Whole days a job has sat in its current stage. */
export function daysInStage(stageLastModified, now = new Date()) {
  if (!stageLastModified) return null;
  const t = new Date(stageLastModified).getTime();
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}
