/**
 * [AUTOMATION]AP WEEKLY SCORECARD: an automated twin of Pema's AP WEEKLY
 * SCORECARD 5/2026, laid out like it, so the two can be compared side by
 * side before Pema switches over (design agreed 2026-10-07).
 *
 * Per week (the current Monday–Sunday week and the next four):
 *   SUBCONTRACTORS   one line per job, due the week AFTER it completes
 *                    (Date Completed, else the later of its last install day
 *                    and install start + MTC working days, Mon–Sat). Amount:
 *                    the job's labor bills in JobProgress, else Labor Est.
 *                    Lines not marked paid by the end of their week move to
 *                    the current week ("carried from week of …").
 *   MATERIAL VENDORS one line per job, due the week its install starts.
 *                    Amount: material bills, else Material Est (30%: the
 *                    cash-planning reserve; 28% stays the performance target).
 *   CARTING          3.5% of the week's scheduled production, except jobs
 *                    with a carting bill, which show the bill.
 *   EXPECTED AR      balances expected that week by the Revenue & AR rule.
 *   Everything bank / finance (fixed expenses, vendor paydowns, payroll,
 *   cash, pending, credit) and Danny's work-order ticks are COPIED from
 *   Pema's tab for the same week. HOLD jobs (job sheet Recognition) are out.
 *
 * Past weeks freeze: their blocks are left as they stand; the live area
 * (current week onward) is rewritten in full on every run.
 */
import { weekBounds, isInstallCode } from "@allied/shared/production";
import { headerColumnMap, parseBlocks, firstInstallDay, colIndex, STALE_STATUSES, RECOGNITION_HEADER } from "./sheetPlan.js";
import { GoogleSheetsClient, a1 } from "../integrations/google/sheets.js";
import { weeklyJobSheetAsService } from "./weeklyJobSheet.js";
import { sheetPushSettings } from "./sheetPush.js";
import { isCompletedStage } from "@allied/shared/jobStages";
import { expectedDayOf, sheetBalance } from "@allied/shared/revenueAr";
import type { CellValue } from "../integrations/google/sheets.js";
import type { SheetRow } from "./weeklyJobSheet.js";

export const AP_TAB_DEFAULT = "[AUTOMATION]AP WEEKLY SCORECARD";
export const AP_SOURCE_TAB_DEFAULT = "AP WEEKLY SCORECARD 5/2026";
/** Unpaid subcontractor lines carry forward from this Monday on (the first week Pema's tab uses this layout). */
export const AP_CARRY_FROM_DEFAULT = "2026-10-05";
export const LIVE_WEEKS = 5;
export const MATERIAL_PCT = 0.30, LABOR_PCT = 0.22, CARTING_PCT = 0.035;

export const COLUMNS = ["INSTALL DATE = INVOICE DATE (COGS)", "CLIENT / JOB", "PAY TO", "AMOUNT", "CATEGORY", "EST / ACT", "DUE DATE",
  "PRIORITY / STATUS", "FINAL WO APPROVED", "FINAL WO READY (CHECK #)", "FINAL WO PAID", "PAYMENT CLEARED", "NOTES", "SOURCE / NOTES"];
const NCOL = COLUMNS.length;
const SRC_SHEET = "[AUTOMATION] WEEKLY JOB SHEET";
const SRC_PEMA = "COPIED FROM AP WEEKLY SCORECARD 5/2026";

export type Cell = CellValue | { formula: string };
export type RowKind = "title" | "panelLabel" | "panelValue" | "note" | "week" | "header" | "subHead" | "sub" | "matHead" | "mat"
  | "fixHead" | "fix" | "cartHead" | "cart" | "opHead" | "op" | "need" | "compare" | "arHead" | "cash" | "notes" | "blank";
export interface OutRow { kind: RowKind; cells: Cell[] }

/** One job, as the AP planner sees it: the job sheet's row plus the feed. */
export interface ApJob {
  jobId: string; label: string; stage: string | null; totalRev: number;
  firstInstall: string | null; lastInstall: string | null; completed: string | null; mtc: number | null;
  sub: string | null; vendor: string | null;
  materialEst: number | null; laborEst: number | null;
  billMaterial: number | null; billLabor: number | null; billCarting: number | null;
  hold: boolean;
  /** For expected collections (the Revenue & AR rule). */
  pifStatus: string | null; completionDate: string | null; gross: number | null; changeOrders: number | null; deposit: number | null; progressPayments: number | null;
}

/** A line of Pema's tab: its section and its A..N cells. */
export interface PemaLine { section: string; cells: CellValue[] }
export interface PemaWeek { monday: string; lines: PemaLine[]; values: Record<string, CellValue> }

const SECTION_HEADS = ["SUBCONTRACTORS", "MATERIAL VENDORS", "FIXED EXPENSES / DEBT SERVICE", "CARTING / DEBRIS / OTHER COGS", "OPERATING CASH SUBTOTAL"];
const VALUE_ROWS = ["WEEKLY CASH NEEDS — ALL UNPAID", "EXPECTED / VERIFIED AR COLLECTIONS", "QXO PORTAL OPEN", "CASH (POSTED)", "DEPOSITED / PENDING",
  "CASH AFTER PENDING CLEARS", "CREDIT AVAILABLE — ALLIED USE", "TOTAL LIQUIDITY AFTER PENDING + CREDIT", "AP OWNER / REVIEW NOTES"];

const str = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const num = (v: unknown) => { const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null; };
const round2 = (n: number) => Math.round(n * 100) / 100;
const addDays = (day: string, n: number) => { const [y, m, d] = day.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10); };
const mondayOf = (day: string) => weekBounds(day).from;
const fmtDay = (day: string) => { const [y, m, d] = day.split("-").map(Number); return `${m}/${d}/${y}`; };
/** A Sheets date serial (days since 1899-12-30) as YYYY-MM-DD. */
export const serialDay = (v: CellValue | undefined): string | null => {
  if (typeof v === "number" && v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86_400_000).toISOString().slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str(v));
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : null;
};
export const daySerial = (day: string) => Math.round((Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) - Date.UTC(1899, 11, 30)) / 86_400_000);

/** Install start + `days` working days (Mon–Sat), the start counting as day 1. */
export function workingDayEnd(start: string, days: number): string {
  let day = start, left = Math.max(1, Math.round(days)) - 1;
  while (left > 0) { day = addDays(day, 1); if (new Date(`${day}T12:00:00Z`).getUTCDay() !== 0) left--; }
  return day;
}

/** The day a job's crew is expected to finish: Date Completed, else the later of last install day and MTC end. */
export function completionDay(j: Pick<ApJob, "completed" | "firstInstall" | "lastInstall" | "mtc">): string | null {
  if (j.completed) return j.completed;
  if (!j.firstInstall) return null;
  const mtcEnd = j.mtc && j.mtc > 0 ? workingDayEnd(j.firstInstall, j.mtc) : null;
  const last = j.lastInstall ?? j.firstInstall;
  return mtcEnd && mtcEnd > last ? mtcEnd : last;
}

/** Reads Pema's tab: every "WEEK OF m/d/yyyy" block, its section lines and its single-value rows. */
export function parsePemaTab(grid: CellValue[][]): Map<string, PemaWeek> {
  const weeks = new Map<string, PemaWeek>();
  let cur: PemaWeek | null = null, section = "";
  for (const row of grid) {
    const a = str(row?.[0]);
    const wk = /^WEEK OF (\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(a);
    if (wk) { const monday = mondayOf(serialDay(wk[1])!); cur = { monday, lines: [], values: {} }; weeks.set(monday, cur); section = ""; continue; }
    if (!cur) continue;
    const head = SECTION_HEADS.find((h) => a.toUpperCase() === h);
    if (head) { section = head; continue; }
    const value = VALUE_ROWS.find((h) => a.toUpperCase() === h);
    if (value) { cur.values[value] = value === "AP OWNER / REVIEW NOTES" ? str(row?.[12]) || str(row?.[1]) : (row?.[3] ?? null); section = ""; continue; }
    if (/^INSTALL DATE = INVOICE DATE/i.test(a)) continue;
    if (!section) continue;
    const cells = Array.from({ length: NCOL }, (_, i) => row?.[i] ?? null);
    if (cells.every((c) => str(c) === "")) continue;
    if (section === "OPERATING CASH SUBTOTAL") { const label = str(cells[2]).toUpperCase(); if (label) cur.values[`OP:${label}`] = cells[3] ?? null; continue; }
    cur.lines.push({ section, cells });
  }
  return weeks;
}

/** Levenshtein distance, for matching Danny's hand-typed client names ("Roscoe Coleman") to job labels. */
function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length]![b.length]!;
}
const words = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length >= 3);
/** True when a hand-typed client name names this job: its surname matches the label's customer surname (two typos allowed). */
export function namesJob(typed: string, label: string): boolean {
  const t = words(typed), customer = words(label.split("/").at(-1) ?? label);
  const surname = t.at(-1);
  if (!surname || customer.length === 0) return false;
  return customer.some((w) => w === surname || (surname.length >= 5 && distance(w, surname) <= 2));
}
/** Danny marked it paid: a check number (J), Final WO paid (K), cleared (L) or a PAID status. */
const isPaid = (cells: CellValue[]) => str(cells[9]) !== "" || str(cells[10]) !== "" || /^(y|yes|true|x)$/i.test(str(cells[11])) || /^paid/i.test(str(cells[7]));
/** ChatGPT's own per-job estimate lines in Pema's tab: replaced by ours, never copied. */
const isPlanningEstimate = (cells: CellValue[]) => /planning estimate/i.test(str(cells[4])) || /—\s*(LABOR|MATERIAL)/i.test(str(cells[1]));
/** ChatGPT's "prior-week subcontractor catch-up" lump: replaced by carrying unpaid subs forward (decision 2). */
const isCatchUp = (cells: CellValue[]) => /catch-?up/i.test(str(cells[1]));

export interface ApPlanInput {
  today: string;
  jobs: ApJob[];
  pema: Map<string, PemaWeek>;
  /** Mondays of the blocks already on our tab before the current week (frozen, never rewritten). */
  carryFrom?: string;
  /** Pema's top-panel values, copied: { "PRIOR-WEEK OPEN / UNCLEARED AP": …, "LIQUIDITY AFTER PENDING + CREDIT": … }. */
  pemaPanel?: Record<string, CellValue>;
  /** Row (0-based) where the live area starts on our tab; formulas use absolute row numbers from here. */
  startRow: number;
  syncedAt: string | null;
}
export interface ApWeekSummary { monday: string; subs: number; materials: number; carting: number; fixed: number; ours: number; pema: number | null }
export interface ApPlan { rows: OutRow[]; weeks: ApWeekSummary[]; panel: OutRow[] }

/** The whole live area: five week blocks, plus the four-row top panel. */
export function planApScorecard(input: ApPlanInput): ApPlan {
  const { today, jobs } = input;
  const carryFrom = input.carryFrom ?? AP_CARRY_FROM_DEFAULT;
  const current = mondayOf(today);
  const mondays = Array.from({ length: LIVE_WEEKS }, (_, i) => addDays(current, 7 * i));
  const live = jobs.filter((j) => !j.hold);
  const rows: OutRow[] = [];
  const summaries: ApWeekSummary[] = [];
  const rowNo = () => input.startRow + rows.length + 1; // 1-based row of the NEXT row pushed
  const blank = (): Cell[] => Array(NCOL).fill(null);
  const push = (kind: RowKind, cells: Cell[]) => { rows.push({ kind, cells: [...cells, ...Array(Math.max(0, NCOL - cells.length)).fill(null)].slice(0, NCOL) }); return rows.length - 1 + input.startRow + 1; };
  const sumRange = (a: number, b: number) => (b >= a ? { formula: `SUM(D${a}:D${b})` } : 0);
  const unpaidRange = (a: number, b: number) => (b >= a ? `SUMIFS(D${a}:D${b},H${a}:H${b},"<>PAID",L${a}:L${b},"<>Y",J${a}:J${b},"",K${a}:K${b},"")` : "0");

  // Subcontractor lines by due week, Danny's typed lines matched by job.
  const subDue = new Map<string, ApJob[]>();
  for (const j of live) { const done = completionDay(j); if (!done) continue; const due = addDays(mondayOf(done), 7); (subDue.get(due) ?? subDue.set(due, []).get(due)!).push(j); }
  const dannyFor = (monday: string, j: ApJob) => input.pema.get(monday)?.lines.find((l) => l.section === "SUBCONTRACTORS" && !isPlanningEstimate(l.cells) && namesJob(str(l.cells[1]), j.label));
  /** The earlier week (before `monday`) where Danny already paid this job's sub, if any: that line stays there, no new line here. */
  const paidEarlier = (monday: string, j: ApJob) => [...input.pema.values()].find((w) => w.monday < monday
    && w.lines.some((l) => l.section === "SUBCONTRACTORS" && !isPlanningEstimate(l.cells) && isPaid(l.cells) && namesJob(str(l.cells[1]), j.label)))?.monday ?? null;
  // Carried: due in a past week (from carryFrom), not marked paid in that week's line.
  const carried: { job: ApJob; from: string }[] = [];
  for (const [due, list] of subDue) if (due < current && due >= carryFrom) for (const j of list) { const d = dannyFor(due, j); if ((!d || !isPaid(d.cells)) && !paidEarlier(due, j)) carried.push({ job: j, from: due }); }

  for (const monday of mondays) {
    const sunday = addDays(monday, 6);
    const inWeek = (day: string | null) => !!day && day >= monday && day <= sunday;
    const pema = input.pema.get(monday);
    push("week", [`WEEK OF ${fmtDay(monday)}`]);
    push("header", COLUMNS);

    // SUBCONTRACTORS
    const subHead = push("subHead", ["SUBCONTRACTORS", null, null, null, null, null, null, null, null, null, null, null,
      "PAYMENT RULE: subcontractors are paid the week after completion; unpaid lines move to the next week."]);
    const subStart = rowNo();
    const used = new Set<PemaLine>();
    const subLines: { job: ApJob; carriedFrom: string | null }[] = [
      ...(monday === current ? carried.map((c) => ({ job: c.job, carriedFrom: c.from })) : []),
      ...(subDue.get(monday) ?? []).filter((job) => !paidEarlier(monday, job)).map((job) => ({ job, carriedFrom: null })),
    ];
    for (const { job, carriedFrom } of subLines) {
      const danny = dannyFor(monday, job) ?? (carriedFrom ? dannyFor(carriedFrom, job) : undefined);
      if (danny) used.add(danny);
      const actual = job.billLabor && job.billLabor > 0 ? job.billLabor : null;
      const typedAmount = danny ? num(danny.cells[3]) : null;
      const amount = round2(typedAmount ?? actual ?? job.laborEst ?? job.totalRev * LABOR_PCT);
      const done = completionDay(job);
      push("sub", [done ? daySerial(done) : null, `${job.label} — LABOR`, str(danny?.cells[2]) || job.sub || "TBD", amount,
        actual || typedAmount ? "Subcontractor — actual" : "Subcontractor — 22% Planning Estimate", actual || typedAmount ? "ACT" : "EST",
        daySerial(monday), danny && isPaid(danny.cells) ? "PAID" : "PLANNED — VERIFY COMPLETION BEFORE PAY",
        danny?.cells[8] ?? null, danny?.cells[9] ?? null, danny?.cells[10] ?? null, danny?.cells[11] ?? null,
        [carriedFrom ? `Carried from week of ${fmtDay(carriedFrom)}.` : "", `Completion ${done ? fmtDay(done) : "?"}${job.completed ? " (Date Completed)" : job.mtc ? ` (MTC ${job.mtc} days)` : ""}.`, str(danny?.cells[12])].filter(Boolean).join(" "),
        danny ? `${SRC_SHEET} + Danny's line` : SRC_SHEET]);
    }
    for (const l of pema?.lines.filter((x) => x.section === "SUBCONTRACTORS" && !used.has(x) && !isPlanningEstimate(x.cells)) ?? []) push("sub", [...l.cells.slice(0, 13), SRC_PEMA]);
    const subEnd = rowNo() - 1;
    rows[subHead - input.startRow - 1]!.cells[3] = sumRange(subStart, subEnd);

    // MATERIAL VENDORS
    const matHead = push("matHead", ["MATERIAL VENDORS", null, null, null, null, null, null, null, null, null, null, null,
      "Material is bought in the install week. 30% of revenue is the cash-planning reserve until actual bills arrive."]);
    const matStart = rowNo();
    for (const job of live.filter((j) => inWeek(j.firstInstall)).sort((a, b) => a.firstInstall!.localeCompare(b.firstInstall!))) {
      const actual = job.billMaterial && job.billMaterial > 0 ? job.billMaterial : null;
      push("mat", [daySerial(job.firstInstall!), `${job.label} — MATERIAL`, job.vendor || "TBD — SHOP QXO / UNIVERSAL / LOCAL",
        round2(actual ?? job.materialEst ?? job.totalRev * MATERIAL_PCT), actual ? "Materials — JobProgress bills" : "Material Vendor — 30% Planning Estimate",
        actual ? "ACT" : "EST", daySerial(job.firstInstall!), "MATERIAL THIS WEEK", null, null, null, null,
        actual ? "Actual material bills in JobProgress." : `30% of ${Math.round(job.totalRev).toLocaleString("en-US")} revenue; replace with the actual quote / bill.`, SRC_SHEET]);
    }
    for (const l of pema?.lines.filter((x) => x.section === "MATERIAL VENDORS" && !isPlanningEstimate(x.cells)) ?? []) push("mat", [...l.cells.slice(0, 13), SRC_PEMA]);
    const matEnd = rowNo() - 1;
    rows[matHead - input.startRow - 1]!.cells[3] = sumRange(matStart, matEnd);

    // FIXED EXPENSES / DEBT SERVICE (copied)
    const fixHead = push("fixHead", ["FIXED EXPENSES / DEBT SERVICE", null, null, null, null, null, null, null, null, null, null, null,
      "Copied from AP WEEKLY SCORECARD 5/2026 for the same week."]);
    const fixStart = rowNo();
    for (const l of pema?.lines.filter((x) => x.section === "FIXED EXPENSES / DEBT SERVICE" && !isCatchUp(x.cells)) ?? []) push("fix", [...l.cells.slice(0, 13), SRC_PEMA]);
    const fixEnd = rowNo() - 1;
    rows[fixHead - input.startRow - 1]!.cells[3] = sumRange(fixStart, fixEnd);

    // CARTING / DEBRIS
    const cartHead = push("cartHead", ["CARTING / DEBRIS / OTHER COGS", null, null, null, null, null, null, null, null, null, null, null,
      "3.5% of the week's scheduled production until actual carting bills replace the reserve."]);
    const cartStart = rowNo();
    const starting = live.filter((j) => inWeek(j.firstInstall));
    const reserveBase = starting.filter((j) => !(j.billCarting && j.billCarting > 0)).reduce((n, j) => n + j.totalRev, 0);
    push("cart", [null, "WEEKLY CARTING / DUMPSTER RESERVE", "CARTING / DEBRIS", round2(reserveBase * CARTING_PCT), "Carting / Debris COGS", "EST", null, "RESERVE",
      null, null, null, null, `3.5% planning reserve on $${Math.round(reserveBase).toLocaleString("en-US")} scheduled production for ${fmtDay(monday)}–${fmtDay(sunday)}.`, SRC_SHEET]);
    for (const j of starting.filter((x) => x.billCarting && x.billCarting > 0)) {
      push("cart", [daySerial(j.firstInstall!), `${j.label} — CARTING`, "CARTING / DEBRIS", round2(j.billCarting!), "Carting / Debris COGS", "ACT", daySerial(j.firstInstall!), null,
        null, null, null, null, "Actual carting bill in JobProgress.", SRC_SHEET]);
    }
    const cartEnd = rowNo() - 1;
    rows[cartHead - input.startRow - 1]!.cells[3] = sumRange(cartStart, cartEnd);

    // OPERATING CASH SUBTOTAL
    const opRow = rowNo();
    push("opHead", ["OPERATING CASH SUBTOTAL", null, null, { formula: `SUM(D${opRow + 1}:D${opRow + 5})` }]);
    push("op", [null, null, "MATERIAL VENDORS", { formula: `D${matHead}` }]);
    push("op", [null, null, "SUBCONTRACTOR PAYROLL", { formula: `D${subHead}` }]);
    push("op", [null, null, "CARTING / DEBRIS", { formula: `D${cartHead}` }]);
    const remote = num(pema?.values["OP:REMOTE PAYROLL"]), acr = num(pema?.values["OP:ACR PAYROLL"]);
    push("op", [null, null, "REMOTE PAYROLL", remote, null, null, null, null, null, null, null, null, pema ? null : "No week in Pema's tab yet.", SRC_PEMA]);
    push("op", [null, null, "ACR PAYROLL", acr, null, null, null, null, null, null, null, null, null, SRC_PEMA]);

    // WEEKLY CASH NEEDS — ALL UNPAID, and the comparison with Pema's tab
    const needRow = push("need", ["WEEKLY CASH NEEDS — ALL UNPAID", null, null,
      { formula: `${unpaidRange(subStart, subEnd)}+${unpaidRange(matStart, matEnd)}+${unpaidRange(fixStart, fixEnd)}+${unpaidRange(cartStart, cartEnd)}+N(D${opRow + 4})+N(D${opRow + 5})` },
      null, null, null, null, null, null, null, null, "Materials, subs, carting, fixed / debt service and payroll not marked PAID.", "CALCULATED"]);
    const pemaNeed = num(pema?.values["WEEKLY CASH NEEDS — ALL UNPAID"]);
    const pemaRow = push("compare", ["PEMA'S TAB — WEEKLY CASH NEEDS", null, null, pemaNeed, null, null, null, null, null, null, null, null,
      pema ? "From AP WEEKLY SCORECARD 5/2026, same week." : "No week in Pema's tab yet.", SRC_PEMA]);
    push("compare", ["DIFFERENCE (AUTOMATED − PEMA)", null, null, pemaNeed === null ? null : { formula: `D${needRow}-D${pemaRow}` }, null, null, null, null, null, null, null, null,
      "Each difference is either a stale typed figure or a rule to adjust.", "CALCULATED"]);

    // EXPECTED / VERIFIED AR COLLECTIONS
    const expected = jobs.filter((j) => j.pifStatus !== "YES").map((j) => ({ j, day: expectedDayOf(j), bal: sheetBalance(j) }))
      .filter((x) => x.bal > 0 && inWeek(x.day)).sort((a, b) => b.bal - a.bal);
    push("arHead", ["EXPECTED / VERIFIED AR COLLECTIONS", null, null, round2(expected.reduce((n, x) => n + x.bal, 0)), null, null, `${fmtDay(monday)}–${fmtDay(sunday)}`, null, null, null, null, null,
      expected.length ? expected.map((x) => `${x.j.label.split("/").at(-1)} $${Math.round(x.bal).toLocaleString("en-US")}`).join("; ") : "None expected by the Revenue & AR rule.",
      "REVENUE & AR RULE: balance expected at completion"]);

    // Cash and liquidity (copied), with the two calculated lines.
    const v = (k: string) => pema?.values[k] ?? null;
    push("cash", ["QXO PORTAL OPEN", null, null, v("QXO PORTAL OPEN"), null, null, null, null, null, null, null, null, null, SRC_PEMA]);
    const cashRow = push("cash", ["CASH (POSTED)", null, null, v("CASH (POSTED)"), null, null, null, null, null, null, null, null, null, SRC_PEMA]);
    const pendRow = push("cash", ["DEPOSITED / PENDING", null, null, v("DEPOSITED / PENDING"), null, null, null, null, null, null, null, null, null, SRC_PEMA]);
    const afterRow = push("cash", ["CASH AFTER PENDING CLEARS", null, null, { formula: `IF(COUNT(D${cashRow}:D${pendRow})=0,"",N(D${cashRow})+N(D${pendRow}))` }, null, null, null, null, null, null, null, null, null, "CALCULATED"]);
    const creditRow = push("cash", ["CREDIT AVAILABLE — ALLIED USE", null, null, v("CREDIT AVAILABLE — ALLIED USE"), null, null, null, null, null, null, null, null, null, SRC_PEMA]);
    push("cash", ["TOTAL LIQUIDITY AFTER PENDING + CREDIT", null, null, { formula: `IF(D${afterRow}="","",N(D${afterRow})+N(D${creditRow}))` }, null, null, null, null, null, null, null, null, null, "CALCULATED"]);
    push("notes", ["AP OWNER / REVIEW NOTES", null, null, null, null, null, null, null, null, null, null, null, str(v("AP OWNER / REVIEW NOTES")) || null, SRC_PEMA]);
    push("blank", blank());

    const sumOf = (from: number, to: number) => {
      let n = 0;
      for (let r = from; r <= to; r++) { const c = rows[r - input.startRow - 1]?.cells ?? []; if (!isPaid(c as CellValue[]) && !/^y$/i.test(str(c[11] as CellValue))) n += num(c[3]) ?? 0; }
      return round2(n);
    };
    summaries.push({ monday, subs: sumOf(subStart, subEnd), materials: sumOf(matStart, matEnd), carting: sumOf(cartStart, cartEnd), fixed: sumOf(fixStart, fixEnd),
      ours: round2(sumOf(subStart, subEnd) + sumOf(matStart, matEnd) + sumOf(cartStart, cartEnd) + sumOf(fixStart, fixEnd) + (remote ?? 0) + (acr ?? 0)), pema: pemaNeed });
  }

  // Top panel (rows 1–4), rewritten every run.
  const firstNeed = rows.findIndex((r) => r.kind === "need");
  const needRows = rows.map((r, i) => (r.kind === "need" ? input.startRow + i + 1 : null)).filter((x): x is number => x !== null);
  const completedAr = round2(jobs.filter((j) => j.pifStatus !== "YES" && isCompletedStage(j.stage)).reduce((n, j) => n + Math.max(0, sheetBalance(j)), 0));
  const startedAr = round2(jobs.filter((j) => j.pifStatus !== "YES" && !isCompletedStage(j.stage) && j.firstInstall && j.firstInstall <= today).reduce((n, j) => n + Math.max(0, sheetBalance(j)), 0));
  const panel: OutRow[] = [
    { kind: "title", cells: ["ALLIED AP + CASH FLOW CONTROL — AUTOMATED (compare with AP WEEKLY SCORECARD 5/2026)", ...Array(NCOL - 1).fill(null)] },
    { kind: "panelLabel", cells: ["COMPLETED AR — LIVE", null, "STARTED OPEN AR — LIVE", null, "PRIOR-WEEK OPEN / UNCLEARED AP", null, "CURRENT-WEEK CASH NEED", null, "30-DAY CASH NEED", null, "LIQUIDITY AFTER PENDING + CREDIT", null, null, null] },
    { kind: "panelValue", cells: [completedAr, null, startedAr, null, input.pemaPanel?.["PRIOR-WEEK OPEN / UNCLEARED AP"] ?? null, null,
      firstNeed >= 0 ? { formula: `D${needRows[0]}` } : null, null, needRows.length ? { formula: needRows.map((r) => `N(D${r})`).join("+") } : null, null,
      input.pemaPanel?.["LIQUIDITY AFTER PENDING + CREDIT"] ?? null, null, null, null] },
    { kind: "note", cells: [`Automated every 15 minutes from ${SRC_SHEET} and JobProgress${input.syncedAt ? ` (last sync ${input.syncedAt.slice(0, 16).replace("T", " ")} UTC)` : ""}. Finance lines and Danny's ticks are copied from AP WEEKLY SCORECARD 5/2026. Past weeks are frozen.`, ...Array(NCOL - 1).fill(null)] },
  ];
  return { rows, weeks: summaries, panel };
}

// ── Reading the sheets and writing the tab ───────────────────────────────────

/** Every feed job as the planner sees it, with the job sheet's MTC, Date Completed, estimates and HOLD where it has a row. */
export function buildApJobs(feed: SheetRow[], jobGrid: CellValue[][]): ApJob[] {
  const idx = headerColumnMap(jobGrid[0]).idx;
  const hdr = (jobGrid[0] ?? []).map((v) => str(v).toLowerCase());
  const recog = hdr.findIndex((h) => h === RECOGNITION_HEADER.toLowerCase());
  const sheetRow = new Map<string, CellValue[]>();
  for (const b of parseBlocks(jobGrid)) for (const i of b.jobIdx) {
    const r = jobGrid[i] ?? [];
    if (STALE_STATUSES.includes(str(r[idx["HY"]!]))) continue;
    const id = str(r[idx["HU"]!]);
    if (id && !sheetRow.has(id)) sheetRow.set(id, r);
  }
  return feed.map((f) => {
    const r = sheetRow.get(f.jobId);
    const installs = (f.visits ?? []).filter((v) => isInstallCode(v.code)).map((v) => v.day).sort();
    return {
      jobId: f.jobId, label: f.label, stage: f.stage, totalRev: Number(f.totalRev ?? f.gross ?? 0) || 0,
      firstInstall: firstInstallDay(f), lastInstall: installs.at(-1) ?? null,
      completed: r ? serialDay(r[idx["AP"]!]) : null, mtc: r ? num(r[idx["AN"]!]) : null,
      sub: f.sub, vendor: f.materialVendor,
      materialEst: r ? num(r[colIndex("AV")]) : null, laborEst: r ? num(r[colIndex("AY")]) : null,
      billMaterial: f.actualMaterial, billLabor: f.actualLabor, billCarting: f.actualCarting,
      hold: !!r && recog >= 0 && str(r[recog]).toUpperCase() === "HOLD",
      pifStatus: f.pifStatus, completionDate: f.completionDate, gross: f.gross, changeOrders: f.changeOrders, deposit: f.deposit, progressPayments: f.progressPayments,
    };
  });
}

/** Pema's top panel: the label in row 2 over its value in row 3, for every labelled column. */
export function pemaPanelOf(grid: CellValue[][]): Record<string, CellValue> {
  const out: Record<string, CellValue> = {};
  (grid[1] ?? []).forEach((label, c) => { const k = str(label).toUpperCase(); if (k) out[k] = grid[2]?.[c] ?? null; });
  return out;
}

/** Where the live area starts on our tab: the first block of the current week or later; else after the last frozen row. */
export function liveStartRow(ours: CellValue[][], today: string): number {
  const current = mondayOf(today);
  let lastUsed = 4;
  for (let i = 4; i < ours.length; i++) {
    const wk = /^WEEK OF (\d{1,2}\/\d{1,2}\/\d{4})$/i.exec(str(ours[i]?.[0]));
    if (wk && mondayOf(serialDay(wk[1])!) >= current) return i;
    if ((ours[i] ?? []).some((v) => str(v) !== "")) lastUsed = i;
  }
  return lastUsed === 4 ? 5 : lastUsed + 2;
}

const rgb = (hex: string) => ({ red: parseInt(hex.slice(0, 2), 16) / 255, green: parseInt(hex.slice(2, 4), 16) / 255, blue: parseInt(hex.slice(4, 6), 16) / 255 });
const FILL: Record<RowKind, string | null> = {
  title: "1E4D2B", panelLabel: "D9EAD3", panelValue: "FFFFFF", note: null, week: "1E5631", header: "E6E6E6",
  subHead: "9FC5E8", sub: "EAF1FB", matHead: "FFD966", mat: "FFF2CC", fixHead: "B4A7D6", fix: "ECE8F5", cartHead: "F9CB9C", cart: "FDF1E4",
  opHead: "A2C4C9", op: "D0E0E3", need: "B6D7A8", compare: "F4CCCC", arHead: "D9EAD3", cash: "D9EAD3", notes: null, blank: null,
};
const WHITE_TEXT = new Set<RowKind>(["title", "week"]);
const DATED = new Set<RowKind>(["sub", "mat", "cart", "fix"]);
const MONEY_PATTERN = "\"$\"#,##0.00";

function cellOf(kind: RowKind, col: number, value: Cell): Record<string, unknown> {
  const fmt: Record<string, unknown> = {
    textFormat: { fontFamily: "Arial", fontSize: kind === "title" ? 11 : 9, bold: kind !== "note", italic: kind === "note", foregroundColor: rgb(WHITE_TEXT.has(kind) ? "FFFFFF" : "000000") },
    wrapStrategy: "CLIP", verticalAlignment: "MIDDLE",
  };
  if (FILL[kind]) fmt["backgroundColor"] = rgb(FILL[kind]!);
  if (col === 3 || (kind === "panelValue" && col % 2 === 0)) fmt["numberFormat"] = { type: "CURRENCY", pattern: MONEY_PATTERN };
  if (DATED.has(kind) && (col === 0 || col === 6)) fmt["numberFormat"] = { type: "DATE", pattern: "m/d/yyyy" };
  let v: Record<string, unknown> | undefined;
  if (value === null || value === undefined || value === "") v = undefined;
  else if (typeof value === "object") v = { formulaValue: `=${value.formula}` };
  else if (typeof value === "number") v = { numberValue: value };
  else if (typeof value === "boolean") v = { boolValue: value };
  else v = { stringValue: String(value) };
  return v ? { userEnteredValue: v, userEnteredFormat: fmt } : { userEnteredFormat: fmt };
}
const rowsData = (rows: OutRow[]) => rows.map((r) => ({ values: r.cells.map((c, i) => cellOf(r.kind, i, c)) }));

export interface ApPushResult { status: "completed" | "skipped" | "failed"; dryRun: boolean; tab: string; reason?: string; startRow?: number; rows?: number; weeks?: ApWeekSummary[]; requests?: number }

export function apSettings(env: NodeJS.ProcessEnv = process.env) {
  return {
    enabled: env.SHEET_AP_SCORECARD === "true",
    tab: env.SHEET_AP_TAB?.trim() || AP_TAB_DEFAULT,
    sourceTab: env.SHEET_AP_SOURCE_TAB?.trim() || AP_SOURCE_TAB_DEFAULT,
    carryFrom: env.SHEET_AP_CARRY_FROM?.trim() || AP_CARRY_FROM_DEFAULT,
  };
}

const officeDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const COLUMN_PX = [150, 330, 220, 110, 230, 70, 90, 230, 90, 140, 90, 90, 420, 230];

/** Rebuilds the live weeks of [AUTOMATION]AP WEEKLY SCORECARD. Writes nothing on a dry run. */
export async function pushApScorecard(options: {
  dryRun: boolean; now?: Date; client?: GoogleSheetsClient;
  feed?: () => Promise<{ rows: SheetRow[]; sync: { finishedAt: string | null } | null }>;
}): Promise<ApPushResult & { plan?: ApPlan }> {
  const ap = apSettings(), sheet = sheetPushSettings();
  const client = options.client ?? GoogleSheetsClient.fromEnv();
  if (!client) return { status: "skipped", dryRun: options.dryRun, tab: ap.tab, reason: sheet.reason || "Google Sheets is not configured" };
  try {
    const tab = await client.sheetByTitle(ap.tab);
    if (!tab) return { status: "skipped", dryRun: options.dryRun, tab: ap.tab, reason: `Create an empty tab named "${ap.tab}" in the spreadsheet` };
    const today = officeDay(options.now ?? new Date());
    const feed = await (options.feed ?? weeklyJobSheetAsService)();
    const [jobGrid, ours] = await Promise.all([client.getValues(a1(sheet.tab, "A1:HZ")), client.getValues(a1(ap.tab, "A1:N4000"))]);
    const pemaGrid = (await client.sheetByTitle(ap.sourceTab)) ? await client.getValues(a1(ap.sourceTab, "A1:N4000")) : [];
    const startRow = liveStartRow(ours, today);
    const plan = planApScorecard({
      today, jobs: buildApJobs(feed.rows, jobGrid), pema: parsePemaTab(pemaGrid), pemaPanel: pemaPanelOf(pemaGrid),
      carryFrom: ap.carryFrom, startRow, syncedAt: feed.sync?.finishedAt ?? null,
    });
    const end = Math.max(ours.length, startRow + plan.rows.length) + 5;
    const range = (r0: number, r1: number) => ({ sheetId: tab.sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: 0, endColumnIndex: NCOL });
    const requests: unknown[] = [];
    if (tab.rowCount < end) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: "ROWS", length: end - tab.rowCount } });
    if (tab.columnCount < NCOL) requests.push({ appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: NCOL - tab.columnCount } });
    requests.push(
      { repeatCell: { range: range(0, 4), cell: {}, fields: "userEnteredValue,userEnteredFormat" } },
      { updateCells: { start: { sheetId: tab.sheetId, rowIndex: 0, columnIndex: 0 }, rows: rowsData(plan.panel), fields: "userEnteredValue,userEnteredFormat" } },
      { repeatCell: { range: range(startRow, end), cell: {}, fields: "userEnteredValue,userEnteredFormat" } },
      { updateCells: { start: { sheetId: tab.sheetId, rowIndex: startRow, columnIndex: 0 }, rows: rowsData(plan.rows), fields: "userEnteredValue,userEnteredFormat" } },
      ...COLUMN_PX.map((px, i) => ({ updateDimensionProperties: { range: { sheetId: tab.sheetId, dimension: "COLUMNS", startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: "pixelSize" } })),
      { updateSheetProperties: { properties: { sheetId: tab.sheetId, gridProperties: { frozenRowCount: 4 } }, fields: "gridProperties.frozenRowCount" } },
    );
    if (!options.dryRun) await client.batchUpdate(requests);
    console.info(`[ap-scorecard] ${options.dryRun ? "dry run" : "pushed"}: ${plan.rows.length} rows from row ${startRow + 1}; `
      + plan.weeks.map((w) => `${w.monday} ours ${w.ours} pema ${w.pema ?? "-"}`).join(" | "));
    return { status: "completed", dryRun: options.dryRun, tab: ap.tab, startRow, rows: plan.rows.length, weeks: plan.weeks, requests: requests.length, plan };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[ap-scorecard] failed: ${message}`);
    return { status: "failed", dryRun: options.dryRun, tab: ap.tab, reason: message };
  }
}
