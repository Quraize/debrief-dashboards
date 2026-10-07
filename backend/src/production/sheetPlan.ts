/**
 * Plans the changes that bring the [AUTOMATION] WEEKLY JOB SHEET tab in line
 * with the feed, as a pure function of what the tab holds now and what the
 * feed says — nothing here talks to Google, so the rules are testable and a
 * dry run is the same code with the writes left unsent.
 *
 * The tab, top to bottom:
 *   row 1        the header;
 *   MONTH AT A GLANCE   a platform-owned block: per month, Projected (installs
 *                scheduled in the month) and Started (install date passed and
 *                the job is in production) — rewritten in place every push;
 *   week blocks  newest first: "M/D/YYYY-M/D/YYYY" label, job rows, Weekly
 *                Total, Cumulative Monthly Total (the tab's own row: this
 *                week plus the earlier weeks of the same month), a spacer.
 *
 * The tab is the team's. The planner therefore recognises a job row by the
 * JobProgress Job ID in column HU and on an existing row rewrites ONLY the
 * synced columns; adds a missing week or job in place; and never deletes — a
 * job the feed no longer places in a week is stamped in the hidden JP Sync
 * Status column instead.
 */
import { MASTER_COLUMNS, MASTER_MANUAL, columnFormula, weekLabel } from "@allied/shared/weeklyJobSheetMaster";
import { labelLink } from "@allied/shared/weeklyJobSheet";
import { weekBounds } from "@allied/shared/production";
import { inPipeline, bucketFor, isReadyStage } from "@allied/shared/soldPipeline";
import { isInstallCode } from "@allied/shared/production";
import { stageKey } from "@allied/shared/jobStages";
import type { SheetRow } from "./weeklyJobSheet.js";
import type { CellValue } from "../integrations/google/sheets.js";

type Column = { col: string; header: string; key?: string; type: string; hidden?: boolean; list?: string[]; formula?: string; fill?: string | null; renamedFrom?: string[] };

export interface WeekInput { from: string; to: string; rows: SheetRow[] }

export interface CellWrite { row: number; col: number; value: CellValue | { formula: string } }
// The planner formats only what is its own: the rows it creates (label, total,
// cumulative, month summary) and the PAID-IN-FULL cell. A job row's other cells
// — the team's fills, font colours, bold — are never written to.
export type RowStyleName = "label" | "total" | "cumulative" | "summary" | "paid" | "unpaid" | "mismatch" | "job";
/** A row's format; `cols` = [start, end) limits it to some columns (default: the whole row). */
export interface RowStyle { row: number; style: RowStyleName; cols?: [number, number] }
export type PlanOp =
  | { type: "insertRows"; at: number; count: number }
  | { type: "write"; cells: CellWrite[] }
  | { type: "style"; rows: RowStyle[] }
  /** Drop a column's data validation (a renamed checkbox column that now holds text). */
  | { type: "clearValidation"; col: number }
  /** Remove rows: only ever a stale copy of a job that carries nothing hand-filled. */
  | { type: "deleteRows"; at: number; count: number };

/** The cell that takes the paid/unpaid colour: B, the PAID-IN-FULL column. */
export const TONE_COLS: [number, number] = [1, 2];

export interface PlanSummary {
  headerCreated: boolean;
  summaryCreated: boolean;
  blocksCreated: string[];
  jobsAdded: number;
  jobsUpdated: number;
  jobsNotThisWeek: number;
  /** Stale copies removed because no hand-filled cell would be lost. */
  jobsRemoved: number;
  /** Hand-pasted rows (no JobProgress ID) the feed took over: matched by Job # or by Town/Address/Customer, ID written in. */
  jobsAdopted: number;
  /** Hand-pasted rows whose job JobProgress places in ANOTHER week: stamped stale here so the revenue counts once, there. */
  jobsElsewhere: number;
  /** Hand-pasted rows the feed could not match to any job — flagged for the team. */
  jobsUnmatched: number;
  /** Whole-week blocks relabelled to the first half of a week now split at a month end. */
  weeksSplit: string[];
  /** The Sales Pre-Approved / Unscheduled block: what it holds and what moved. */
  preApproved: { created: boolean; jobs: number; added: string[]; left: string[]; kept: string[]; carried: string[] } | null;
  cellsWritten: number;
  /** Per week: what happened, for the dry-run report. */
  weeks: { label: string; existing: boolean; added: string[]; updated: string[]; notThisWeek: string[]; removed: string[]; adopted: string[]; elsewhere: string[]; unmatched: string[] }[];
  /** The month lines as written, for the dry-run report. */
  months: { label: string; jobs: number; gross: number }[];
  /** Week blocks that are past their Thursday and must be read-only, with their final row span. */
  locks: WeekLock[];
  /** Synced columns written where the TAB's heading sits rather than the template's letter. */
  columnsFollowed: { header: string; template: string; tab: string }[];
  /** The estimate / GP block (costTotals): what was written, or why it was skipped. */
  costBlock: { status: string; jobRows: number; totalRows: number; monthRows: number } | null;
  /** Headings rewritten because the template renamed them (B: "PIF" → the status column). */
  headersRenamed: { from: string; to: string; col: string }[];
  /** TRUE/FALSE leftovers from column B's checkbox days, cleared off rows the feed does not write. */
  checkboxLeftoversCleared: number;
}

/**
 * A week block to protect: rows `startRow` up to (not including) `endRow`,
 * every column. `since` is the office day the lock took effect — the Friday
 * of that week, i.e. the end of its Thursday.
 */
export interface WeekLock { label: string; from: string; to: string; startRow: number; endRow: number; since: string }

/** The office day a week becomes read-only: end of its Thursday = 00:00 Friday. */
export function lockDate(from: string): string {
  // The Friday of the calendar week `from` sits in — so both halves of a week
  // split at a month end (9/28–9/30, 10/1–10/4) lock together, on 10/2.
  const monday = weekBounds(from.slice(0, 10)).from;
  const [y, m, d] = monday.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + 4)).toISOString().slice(0, 10);
}

/** "Fri 9/18/2026" for the lock note. */
export function lockNote(from: string): string {
  const [y, m, d] = lockDate(from).split("-").map(Number);
  return `🔒 Locked since Fri ${m}/${d}/${y} — read-only; JobProgress figures still update`;
}

/** Every block on the grid whose week is past its Thursday, with the rows it occupies now. */
export function lockedBlocks(grid: CellValue[][], today: string): WeekLock[] {
  return parseBlocks(grid)
    .filter((b) => lockDate(b.from) <= today)
    .map((b) => ({
      label: weekLabel(b.from, b.to), from: b.from, to: b.to,
      startRow: b.labelIdx, endRow: blockEnd(b) + 1, since: lockDate(b.from),
    }));
}

/** `grid` is the tab as it will be once every op has run — what the dashboard's data tab is built from. */
export interface Plan { ops: PlanOp[]; summary: PlanSummary; grid: CellValue[][] }

export const SYNC_STATUS_OK = "Synced from JobProgress";
/**
 * HY on a row that is not this week's: the install moved, it starts in another
 * week (this is a return visit), or it left the calendar. Out of every total.
 */
export const SYNC_STATUS_STALE = "Not counted here — install does not start this week";
/** The earlier wording of the same stamp; rows still carrying it stay out of the totals too. */
export const SYNC_STATUS_STALE_LEGACY = "Not on the JobProgress calendar this week";
export const STALE_STATUSES = [SYNC_STATUS_STALE, SYNC_STATUS_STALE_LEGACY];
/** A hand-pasted row (no JobProgress ID) the feed could not match to any job it placed. */
export const SYNC_STATUS_UNMATCHED = "Not matched to a JobProgress job";
export const SUMMARY_MARKER = "MONTH AT A GLANCE";
/** The standing block of sold jobs with no production date, under the month summary. */
export const PREAPPROVED_LABEL = "Sales Pre-Approved / Unscheduled";
/** HY on a row that left the block but still carries the team's cells (its week is not in this push yet). */
export const SYNC_STATUS_LEFT_PREAPPROVED = "Scheduled or closed in JobProgress — hand-filled cells kept here";
// "(through this week)" because the row on the newest block adds the weeks
// that have not happened yet — it is the month's schedule to that point, not
// its production, and the old name was read as the latter.
export const CUMULATIVE_LABEL = "Cumulative Monthly Total (through this week)";

/** "A" → 0, "AC" → 28, "HU" → 228. */
export function colIndex(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

const LABEL_RE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/;
const iso = (y: string, m: string, d: string) => `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;

/** The from/to of a week-label cell, or null when the cell is not one. */
export function parseWeekLabel(v: CellValue): { from: string; to: string } | null {
  const m = LABEL_RE.exec(String(v ?? ""));
  return m ? { from: iso(m[3]!, m[1]!, m[2]!), to: iso(m[6]!, m[4]!, m[5]!) } : null;
}

/** Google Sheets date serial: days since 1899-12-30. */
export function dateSerial(isoDay: string): number {
  const [y, m, d] = isoDay.slice(0, 10).split("-").map(Number);
  return Math.round((Date.UTC(y!, m! - 1, d!) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
export function dateTimeSerial(isoTs: string): number {
  return (new Date(isoTs).getTime() - Date.UTC(1899, 11, 30)) / 86_400_000;
}

const COLS = MASTER_COLUMNS as Column[];
const IDX = Object.fromEntries(COLS.map((c) => [c.col, colIndex(c.col)])) as Record<string, number>;
const TOTALLED = ["R", "S", "T", "Y", "Z", "AA", "AB"];

/** 0 → "A", 28 → "AC". */
export function colLetter(index: number): string {
  let n = index + 1, s = "";
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/**
 * Where each synced column's VALUE is written: by the tab's own heading.
 *
 * The template puts Scheduled Install Date at P and Sale Date at Q, and so
 * did the code — by letter. Then someone swapped the two headings on the
 * live tab, and every install date landed under "Sale Date" and vice versa.
 * A heading is what a reader trusts, so a heading is what we follow: for a
 * synced column whose expected heading is not at its template letter but IS
 * found (once) elsewhere on row 1, write there. Formula columns keep their
 * template letters — their formulas reference letters — and a heading that
 * is missing or ambiguous falls back to the template.
 */
export function headerColumnMap(headerRow: CellValue[] | undefined): { idx: Record<string, number>; followed: { header: string; template: string; tab: string }[] } {
  const idx = { ...IDX };
  const followed: { header: string; template: string; tab: string }[] = [];
  if (!headerRow || headerRow.length === 0) return { idx, followed };
  const norm = (v: CellValue | undefined) => cellStr(v).toLowerCase().replace(/[^a-z0-9$#%]+/g, " ").trim();
  const where = new Map<string, number[]>();
  headerRow.forEach((v, i) => { const k = norm(v); if (k) (where.get(k) ?? where.set(k, []).get(k)!).push(i); });
  // Every column with a heading is followed, the team's checkbox columns
  // included, so the tab's columns can be reordered (PIF Date before
  // PAID-IN-FULL, Warranty Filed beside Job Complete) and each value still
  // lands under its own heading. A heading that appears more than once
  // ("PIF Date" is also a hidden ledger column) resolves to the hit nearest
  // the template's position.
  for (const c of COLS) {
    if (c.formula || !c.header) continue;
    const want = norm(c.header);
    const home = IDX[c.col]!;
    if (norm(headerRow[home]) === want) continue;
    const hits = where.get(want);
    if (!hits || hits.length === 0) continue;
    const hit = hits.reduce((best, i) => (Math.abs(i - home) < Math.abs(best - home) ? i : best), hits[0]!);
    if (hit !== home) {
      idx[c.col] = hit;
      followed.push({ header: c.header, template: c.col, tab: colLetter(hit) });
    }
  }
  return { idx, followed };
}

/** The column map in force while a plan is being built (set by planSheet). */
let ACTIVE: Record<string, number> = IDX;
const JOB_ID_COL = () => ACTIVE["HU"]!;

/**
 * The estimate / GP block, AV..BE: the job-row formulas Pema's ChatGPT work
 * put on the tab (estimate = the job's JOB COST / AP LEDGER cost if logged,
 * else 30% material / 1% dealer fee / 22% labor of Total Rev; GP estimate a
 * flat 35%; GP actual copied from BN/BO). Owned by the automation since
 * 2026-10-07 (decision 5): written on every job row each push, so new and
 * moved jobs have them and nobody types estimates. Not template formulas:
 * the Excel export has no ledger tab.
 */
const LEDGER = "'JOB COST / AP LEDGER'";
const ledgerEst = (r: number, cat: string, pct: number) =>
  `IF($A${r}="","",IF(COUNTIFS(${LEDGER}!$A$6:$A$1000,$A${r},${LEDGER}!$C$6:$C$1000,"${cat}",${LEDGER}!$E$6:$E$1000,">0",${LEDGER}!$J$6:$J$1000,"<>Voided")>0,`
  + `SUMIFS(${LEDGER}!$E$6:$E$1000,${LEDGER}!$A$6:$A$1000,$A${r},${LEDGER}!$C$6:$C$1000,"${cat}",${LEDGER}!$J$6:$J$1000,"<>Voided"),IF($T${r}="","",$T${r}*${pct}%)))`;
export const EST_JOB_FORMULAS: Record<string, (r: number) => string> = {
  AV: (r) => ledgerEst(r, "Material", 30),
  AW: (r) => `IFERROR(AV${r}/T${r},"")`,
  AX: (r) => ledgerEst(r, "Dealer Fee", 1),
  AY: (r) => ledgerEst(r, "Labor / Subcontractor", 22),
  AZ: (r) => `IFERROR(AY${r}/T${r},"")`,
  BA: (r) => `IF(T${r}="","",35%)`,
  BB: (r) => `IF(BO${r}="","",BO${r})`,
  BC: (r) => `IF(OR(BA${r}="",BB${r}=""),"",BB${r}-BA${r})`,
  BD: (r) => `IF(T${r}="","",T${r}*35%)`,
  BE: (r) => `IF(BN${r}="","",BN${r})`,
};
const OWNED_COLS = new Set(Object.keys(EST_JOB_FORMULAS));
/** Columns the cost block reads or writes by letter; each must carry its template heading or the block is skipped. */
const COST_BLOCK_COLS = ["T", ...OWNED_COLS, "BH", "BI", "BJ", "BK", "BL", "BM", "BN", "BO", "BP", "BQ", "BR", "BS"];
/** Optional team columns found by heading: HOLD marker (decision 4) and the Final Job Costing Complete tick. */
export const RECOGNITION_HEADER = "Recognition";
const FINAL_JCC_HEADER = "final job costing complete";

/**
 * Estimate and actual totals for one total row (Weekly Total, Cumulative,
 * Month at a Glance) over the job rows given (1-based numbers are built
 * here). Dollar columns are summed; percentages are recomputed from the
 * summed dollars over the summed revenue of the same rows, never averaged.
 * HOLD rows (Recognition column) are left out of every cost and GP figure.
 * Actual GP counts only jobs with Final Job Costing Complete ticked, as the
 * ChatGPT formulas did. Rewritten every push from the rows actually there,
 * so a moved or deleted job never leaves a #REF!.
 */
function costTotalCells(tr: number, rows: number[], holdCol: string | null, jccCol: string | null): CellWrite[] {
  const r = tr + 1;
  const ns = rows.map((i) => i + 1);
  const hold = (n: number) => (holdCol ? `*(${holdCol}${n}<>"HOLD")` : "");
  const join = (term: (n: number) => string) => (ns.length ? ns.map(term).join("+") : "0");
  const sum = (X: string) => join((n) => `N(${X}${n})${hold(n)}`);
  const count = (X: string) => join((n) => `(${X}${n}<>"")${hold(n)}`);
  const rev = join((n) => `N(T${n})${hold(n)}`);
  const revWith = (X: string) => join((n) => `N(T${n})*(${X}${n}<>"")${hold(n)}`);
  const f = (L: string, formula: string | null): CellWrite => ({ row: tr, col: IDX[L]!, value: formula === null ? null : { formula } });
  const out: CellWrite[] = [
    f("AV", sum("AV")), f("AX", sum("AX")), f("AY", sum("AY")), f("BD", sum("BD")),
    f("AW", `IFERROR(AV${r}/(${rev}),"")`), f("AZ", `IFERROR(AY${r}/(${rev}),"")`), f("BA", `IFERROR(BD${r}/(${rev}),"")`),
    ...["BH", "BI", "BJ", "BK", "BL"].map((X) => f(X, `IF((${count(X)})=0,"",${sum(X)})`)),
    f("BM", `IF(COUNT(BH${r}:BL${r})=0,"",SUM(BH${r}:BL${r}))`),
  ];
  if (jccCol) {
    const den = join((n) => `N(T${n})*(${jccCol}${n}=TRUE)${hold(n)}`);
    const gp = join((n) => `N(BN${n})*(${jccCol}${n}=TRUE)${hold(n)}`);
    out.push(f("BN", `IF((${den})=0,"",${gp})`), f("BO", `IF((${den})=0,"",BN${r}/(${den}))`));
  } else {
    out.push(f("BN", null), f("BO", null));
  }
  [["BP", "BH"], ["BQ", "BI"], ["BR", "BJ"], ["BS", "BK"]].forEach(([P, X]) => out.push(f(P!, `IF((${revWith(X!)})=0,"",${X}${r}/(${revWith(X!)}))`)));
  out.push(f("BB", `IF(BO${r}="","",BO${r})`), f("BC", `IF(OR(BA${r}="",BB${r}=""),"",BB${r}-BA${r})`), f("BE", `IF(BN${r}="","",BN${r})`));
  return out;
}

const cellStr = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v).trim());

/** The value a synced column takes for a row; null = leave blank. */
export function syncedValue(column: Column, row: SheetRow, syncedAt: string | null): CellValue | { formula: string } | null {
  if (column.formula) return null; // formulas are placed by rowValues, they need the row number
  if (!column.key) return null;
  if (column.key === "syncedAt") return syncedAt ? dateTimeSerial(syncedAt) : null;
  if (column.key === "syncStatus") return SYNC_STATUS_OK;
  const v = (row as unknown as Record<string, unknown>)[column.key];
  // The status column is cleared when a job has none, so a tick left from the column's checkbox days goes away.
  if (column.key === "pifStatus") return v ? String(v) : "";
  // Column A keeps its text and opens the job in JobProgress when clicked.
  // (Plain text 10/2-10/6 to avoid Google's link pop-up; the team chose the
  // link back and turns off "Show link details" in their own accounts.)
  if (column.key === "label") return v === null || v === undefined || v === "" ? null : labelLink(v, row.jpUrl);
  if (column.type === "check") return Boolean(v);
  if (v === null || v === undefined || v === "") return null;
  if (column.type === "date") return dateSerial(String(v));
  if (column.type === "datetime") return dateTimeSerial(String(v));
  if (column.type === "money" || column.type === "pct") return Number(v);
  return String(v);
}

/** Every cell of a brand-new job row: synced values, formulas, unticked checkboxes. */
function newRowCells(rowIdx: number, row: SheetRow, syncedAt: string | null): CellWrite[] {
  const out: CellWrite[] = [];
  for (const c of COLS) {
    const formula = columnFormula(c, rowIdx + 1);
    if (formula) { out.push({ row: rowIdx, col: IDX[c.col]!, value: { formula } }); continue; }
    const col = ACTIVE[c.col]!;
    const v = syncedValue(c, row, syncedAt);
    if (v === "") continue; // nothing to clear on a new row
    if (v !== null) out.push({ row: rowIdx, col, value: v });
    else if (c.type === "check") out.push({ row: rowIdx, col, value: false });
  }
  return out;
}

/** The PAID-IN-FULL cell's colour on a job row: green YES, red NO, amber warning. */
function toneStyle(rowIdx: number, row: SheetRow): RowStyle[] {
  if (!row.statusTone) return [];
  // PAID-IN-FULL and PIF Date, wherever the tab has them (they need not be adjacent).
  const b = ACTIVE["B"]!, c = ACTIVE["C"]!;
  const cells = c === b + 1 ? [[b, c + 1]] : [[b, b + 1], [c, c + 1]];
  return cells.map(([c0, c1]) => ({ row: rowIdx, style: row.statusTone!, cols: [c0!, c1!] as [number, number] }));
}

/** Blank, or a formula error (#REF! from a pasted row, #VALUE!…): the row formula belongs back there. */
const brokenOrBlank = (v: CellValue | undefined) => { const s = cellStr(v); return s === "" || /^#(REF!|N\/A|VALUE!|DIV\/0!|ERROR!|NAME\?|NUM!|NULL!)$/.test(s); };

/**
 * Only the synced columns of an existing row — the team's cells stay as they
 * are. A row formula (Total Rev = Gross + C.O.s, Balance = Total − Paid) that
 * was cleared or overwritten with a blank is put back, so the row and the
 * totals above it add up again; a value someone typed there is left alone.
 */
function updateRowCells(rowIdx: number, row: SheetRow, syncedAt: string | null, cells?: CellValue[]): CellWrite[] {
  const out: CellWrite[] = [];
  for (const c of COLS) {
    const formula = columnFormula(c, rowIdx + 1);
    if (formula) {
      if (cells && brokenOrBlank(cells[ACTIVE[c.col]!])) out.push({ row: rowIdx, col: ACTIVE[c.col]!, value: { formula } });
      continue;
    }
    if (!c.key) continue;
    const v = syncedValue(c, row, syncedAt);
    if (v === "") out.push({ row: rowIdx, col: ACTIVE[c.col]!, value: null });
    else if (v !== null) out.push({ row: rowIdx, col: ACTIVE[c.col]!, value: v });
  }
  return out;
}

/**
 * The block's Weekly Total: the money columns summed over its job rows, except
 * rows stamped "not on the calendar this week". Those rows stay on the tab so
 * the team's hand-filled cells survive, but a job whose install moved to
 * another week is not this week's production.
 */
function totalRowCells(rowIdx: number, firstJob: number, lastJob: number): CellWrite[] {
  const out: CellWrite[] = [{ row: rowIdx, col: IDX["A"]!, value: "Weekly Total" }];
  const f = firstJob + 1, l = lastJob + 1;
  for (const L of TOTALLED) {
    const value = L === "AB" ? { formula: balanceOf(rowIdx) }
      : lastJob >= firstJob ? { formula: `SUMIFS(${L}${f}:${L}${l}${STALE_STATUSES.map((t) => `,HY${f}:HY${l},"<>${t}"`).join("")})` } : 0;
    out.push({ row: rowIdx, col: IDX[L]!, value });
  }
  return out;
}

/**
 * A total row's Balance Owed is its own Total Rev minus its own Total Paid,
 * never a sum of the rows' balance cells: one blank balance cell on a job row
 * made the September running balance $22,000 short.
 */
const balanceOf = (rowIdx: number) => `T${rowIdx + 1}-AA${rowIdx + 1}`;

/**
 * Cumulative Monthly Total (through this week): this block's job rows plus
 * every row below its cumulative row down to the month's oldest block, each
 * JOB counted once. A roof that installs Thursday–Monday sits in two week
 * blocks and both weekly totals; summing the weekly totals counted it twice,
 * which is how the tab came to show $728K for a $381K month.
 *
 * Two ranges, not one: the span must skip the block's own Weekly Total and
 * Cumulative rows — a range that includes the cell the formula lives in is a
 * circular reference to Sheets, whatever the arithmetic does with it. Per
 * money column, over each range:
 *   - skip the other blocks' Weekly Total and Cumulative rows (sums, not jobs);
 *   - skip rows stamped not-this-week;
 *   - a number in the money column counts, anything else is 0;
 *   - divide by how many LIVE rows (not stamped) carry the row's Job # (AC)
 *     across BOTH ranges, so a job in two blocks contributes half from each;
 *     a row with no Job # (a hand-added job) divides by 1.
 *
 * `ownJobs` and `below` are 0-based inclusive row spans; `below` is null for
 * the month's oldest block.
 */
function cumulativeRowCells(rowIdx: number, ownJobs: [number, number] | null, below: [number, number] | null): CellWrite[] {
  const out: CellWrite[] = [{ row: rowIdx, col: IDX["A"]!, value: CUMULATIVE_LABEL }];
  const spans = [ownJobs, below].filter((x): x is [number, number] => x !== null && x[1] >= x[0]);
  const ac = (sp: [number, number]) => `AC${sp[0] + 1}:AC${sp[1] + 1}`;
  const hy = (sp: [number, number]) => `HY${sp[0] + 1}:HY${sp[1] + 1}`;
  for (const L of TOTALLED) {
    if (L === "AB") { out.push({ row: rowIdx, col: IDX[L]!, value: { formula: balanceOf(rowIdx) } }); continue; }
    const terms = spans.map((sp) => {
      const s = sp[0] + 1, e = sp[1] + 1;
      const A = `A${s}:A${e}`, HY = `HY${s}:HY${e}`, AC = ac(sp);
      // How many LIVE rows carry this Job #, across both ranges. Stamped rows
      // must not count: a job that moved from last week to this one has a live
      // row here and a stamped twin there, and counting the twin halved it.
      const counts = spans.map((other) => `COUNTIFS(${ac(other)},${AC}&""${STALE_STATUSES.map((t) => `,${hy(other)},"<>${t}"`).join("")})`).join("+");
      const live = STALE_STATUSES.map((t) => `*(${HY}<>"${t}")`).join("");
      const stamped = STALE_STATUSES.map((t) => `+(${HY}="${t}")`).join("");
      // Denominator is never 0: a blank Job # divides by 1, and a stamped row
      // (numerator already 0) gets +1 so a job with no live row is not 0/0.
      return `SUMPRODUCT((${A}<>"Weekly Total")*(LEFT(${A},10)<>"Cumulative")${live}`
        + `*IFERROR(1*${L}${s}:${L}${e},0)/((${AC}<>"")*(${counts})+(${AC}="")${stamped}))`;
    });
    out.push({ row: rowIdx, col: IDX[L]!, value: terms.length ? { formula: terms.join("+") } : 0 });
  }
  return out;
}

export interface Block { labelIdx: number; from: string; to: string; jobIdx: number[]; totalIdx: number | null; cumulativeIdx: number | null }

/** Reads the tab's week blocks off the grid. The month block and the header are not blocks. */
export function parseBlocks(grid: CellValue[][]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 1; i < grid.length; i++) {
    const a = grid[i]?.[0] ?? null;
    const label = parseWeekLabel(a);
    if (label) { cur = { labelIdx: i, ...label, jobIdx: [], totalIdx: null, cumulativeIdx: null }; blocks.push(cur); continue; }
    const text = cellStr(a);
    if (/^cumulative monthly total\b/i.test(text)) { const last = blocks[blocks.length - 1]; if (last && last.totalIdx !== null && last.cumulativeIdx === null) last.cumulativeIdx = i; continue; }
    if (!cur) continue;
    if (/^weekly total$/i.test(text)) { cur.totalIdx = i; cur = null; continue; }
    const rowHasContent = (grid[i] ?? []).some((v) => cellStr(v) !== "" && v !== false);
    if (rowHasContent) cur.jobIdx.push(i);
  }
  return blocks;
}

/** Last row of a block (cumulative, else total, else label). */
const blockEnd = (b: Block) => b.cumulativeIdx ?? b.totalIdx ?? b.labelIdx;

// ── Month at a glance ────────────────────────────────────────────────────────

/** Stages that mean the crew has started: Production Started and everything after it. */
const STARTED_STAGES = new Set([
  "Production Started", "Gutters/Solar/Punchlist", "Need Final Walk-Through",
  "City & Manufacturer Inspection", "COMPLETED NEED FINAL PAYMENT!!",
].map(stageKey));

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthOf = (isoDay: string) => isoDay.slice(0, 7);
const monthTitle = (ym: string) => `${MONTH_NAMES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * The day a job's install starts: its first install visit on the calendar
 * (RR, SR, GUTTERS…), completed or not. The sheet counts a job's money in this
 * day's week and month only; a return visit later (a second siding day, the
 * gutters, a punch list) is not new production, and counting it again put the
 * same contract in two months.
 */
export function firstInstallDay(r: Pick<SheetRow, "visits">): string | null {
  let first: string | null = null;
  for (const v of r.visits) if (isInstallCode(v.code) && (first === null || v.day < first)) first = v.day;
  return first;
}

/**
 * No money, no row (the production manager's rule): a job whose contract is
 * $0 — a warranty callback, a no-charge service visit, a placeholder — gets
 * no row in any week, the month summary or the pre-approved block. A job whose
 * amount is MISSING (not entered in JobProgress yet) is not $0 and stays.
 */
export function bringsMoney(r: Pick<SheetRow, "totalRev" | "gross">): boolean {
  const v = r.totalRev ?? r.gross;
  return v === null || v === undefined || Number(v) !== 0;
}

/** Weeks starting on or after this Monday are cut at a month end (SHEET_SPLIT_WEEKS_FROM). */
export const sheetSplitFrom = (env: NodeJS.ProcessEnv = process.env): string => env.SHEET_SPLIT_WEEKS_FROM || "2026-09-28";

export interface MonthLine { label: string; jobs: number; gross: number; totalRev: number; deposit: number; paid: number; owed: number }

/**
 * Two lines per month, for the month `today` is in and the month before it:
 *   Projected — jobs whose install starts in the month (firstInstallDay);
 *   Started   — of those, jobs whose install day has passed and whose stage
 *               says production started (or later).
 */
export function monthLines(rows: SheetRow[], today: string): MonthLine[] {
  const thisMonth = monthOf(today);
  const [y, m] = thisMonth.split("-").map(Number);
  const prevMonth = `${m === 1 ? y! - 1 : y}-${String(m === 1 ? 12 : m! - 1).padStart(2, "0")}`;
  const out: MonthLine[] = [];
  for (const ym of [thisMonth, prevMonth]) {
    const projected = rows.filter((r) => { const d = firstInstallDay(r); return d !== null && monthOf(d) === ym; });
    const started = projected.filter((r) => firstInstallDay(r)! <= today && STARTED_STAGES.has(stageKey(r.stage)));
    const sum = (set: SheetRow[], key: keyof SheetRow) => Math.round(set.reduce((n, r) => n + (Number(r[key]) || 0), 0) * 100) / 100;
    const line = (kind: string, set: SheetRow[], what: string): MonthLine => ({
      label: `${monthTitle(ym)} — ${kind}: ${set.length} job${set.length === 1 ? "" : "s"} ${what}, ${money(sum(set, "totalRev"))}`,
      jobs: set.length, gross: sum(set, "gross"), totalRev: sum(set, "totalRev"), deposit: sum(set, "deposit"), paid: sum(set, "totalPayments"), owed: sum(set, "balanceOwed"),
    });
    out.push(line("Projected", projected, "with the install starting this month"));
    out.push(line("Started", started, "with the install started (in production)"));
  }
  return out;
}

function monthLineCells(rowIdx: number, l: MonthLine): CellWrite[] {
  return [
    { row: rowIdx, col: IDX["A"]!, value: l.label },
    { row: rowIdx, col: ACTIVE["R"]!, value: l.gross },
    { row: rowIdx, col: ACTIVE["T"]!, value: l.totalRev },
    { row: rowIdx, col: ACTIVE["Y"]!, value: l.deposit },
    { row: rowIdx, col: ACTIVE["AA"]!, value: l.paid },
    { row: rowIdx, col: ACTIVE["AB"]!, value: l.owed },
  ];
}

// ── The plan ─────────────────────────────────────────────────────────────────

export interface PlanOptions {
  now?: Date;
  syncedAt: string | null;
  /** Office day (YYYY-MM-DD) the push runs on; drives the month lines. */
  today?: string;
  /** Every feed row (not just the pushed weeks) — the month lines count across weeks. */
  allRows?: SheetRow[];
  /** Skip the month block (tests of the week layout). */
  monthSummary?: boolean;
  /** Compute week locks (blocks past their Thursday) and their label notes. Default true. */
  lockWeeks?: boolean;
  /** Remove a stale copy that carries nothing hand-filled (SHEET_REMOVE_EMPTY_STALE). Off: every stale row is stamped and kept. */
  removeEmptyStale?: boolean;
  /** Write the Sales Pre-Approved / Unscheduled block. Default: on whenever the month summary is. */
  preApproved?: boolean;
  /** Own the estimate / GP block: job-row estimate formulas and every total row's estimate and actual totals (SHEET_COST_TOTALS). Default off. */
  costTotals?: boolean;
}

export function planSheet(gridIn: CellValue[][], weeks: WeekInput[], opts: PlanOptions): Plan {
  // Work on a copy: row insertions shift indices, and the emitted operations
  // must use the indices the sheet will have at the moment each one runs.
  const grid: CellValue[][] = gridIn.map((r) => [...r]);
  const ops: PlanOp[] = [];
  const summary: PlanSummary = {
    headerCreated: false, summaryCreated: false, blocksCreated: [], jobsAdded: 0, jobsUpdated: 0, jobsNotThisWeek: 0, jobsRemoved: 0, jobsAdopted: 0, jobsElsewhere: 0, jobsUnmatched: 0, preApproved: null, weeksSplit: [], cellsWritten: 0, weeks: [], months: [], locks: [], columnsFollowed: [], headersRenamed: [], checkboxLeftoversCleared: 0, costBlock: null,
  };
  // Write each synced value where the tab's heading for it sits.
  const headerMap = headerColumnMap(grid[0]);
  ACTIVE = headerMap.idx;
  summary.columnsFollowed = headerMap.followed;
  try {
    return buildPlan();
  } finally {
    ACTIVE = IDX;
  }

  function buildPlan(): Plan {
  // Writes are mirrored into the model too, so later steps see the labels and
  // job ids they just placed (a block inserted above shifts everything below).
  const write = (cells: CellWrite[]) => {
    if (!cells.length) return;
    ops.push({ type: "write", cells });
    summary.cellsWritten += cells.length;
    for (const c of cells) {
      const r = (grid[c.row] ??= []);
      r[c.col] = typeof c.value === "object" && c.value !== null ? `=${c.value.formula}` : c.value;
    }
  };
  const insert = (at: number, count: number) => {
    ops.push({ type: "insertRows", at, count });
    grid.splice(at, 0, ...Array.from({ length: count }, () => [] as CellValue[]));
  };
  const remove = (at: number, count: number) => {
    ops.push({ type: "deleteRows", at, count });
    grid.splice(at, count);
  };
  /**
   * True when the team typed or ticked anything in a hand-filled column of
   * this row. Formula columns (the ledger percentages, BM..BS) are not the
   * team's: the sheet computes them from synced cells, and a 0.0% on an
   * otherwise empty row is not a reason to keep it.
   */
  // With the cost block on, the estimate columns are the automation's: not carried, not a reason to keep a row.
  const HAND_COLUMNS = (MASTER_MANUAL as Column[]).filter((c) => !c.formula && !(opts.costTotals && OWNED_COLS.has(c.col)));
  const hasHandFilled = (cells: CellValue[] | undefined) => HAND_COLUMNS.some((c) => {
    const v = cells?.[ACTIVE[c.col]!];
    if (v === null || v === undefined || v === false) return false;
    const s = cellStr(v);
    return s !== "" && s.toUpperCase() !== "FALSE";
  });
  const style = (rows: RowStyle[]) => { if (rows.length) ops.push({ type: "style", rows }); };

  // Header: written when the tab is empty or row 1 is blank.
  if (grid.length === 0 || cellStr(grid[0]?.[0]) === "" && cellStr(grid[0]?.[1]) === "") {
    if (grid.length === 0) grid.push([]);
    write(COLS.map((c) => ({ row: 0, col: IDX[c.col]!, value: c.header })));
    summary.headerCreated = true;
  } else {
    // A heading the template has since renamed (B: "PIF" → the status text)
    // is rewritten where it stands, and the column's old checkbox rule is
    // dropped so the text can live there.
    const renames: CellWrite[] = [];
    for (const c of COLS) {
      if (!c.renamedFrom) continue;
      const col = ACTIVE[c.col]!;
      const have = cellStr(grid[0]?.[col]);
      if (c.renamedFrom.some((old) => old.toLowerCase() === have.toLowerCase())) {
        renames.push({ row: 0, col, value: c.header });
        ops.push({ type: "clearValidation", col });
        summary.headersRenamed.push({ from: have, to: c.header, col: colLetter(col) });
      }
    }
    write(renames);
  }

  // Month at a glance: a fixed block right under the header, rewritten in place.
  let firstBlockRow = 1;
  if (opts.monthSummary !== false) {
    const today = opts.today ?? (opts.now ?? new Date()).toISOString().slice(0, 10);
    const lines = monthLines(opts.allRows ?? weeks.flatMap((w) => w.rows), today);
    summary.months = lines.map((l) => ({ label: l.label, jobs: l.jobs, gross: l.gross }));
    let markerIdx = grid.findIndex((r, i) => i > 0 && cellStr(r?.[0]) === SUMMARY_MARKER);
    if (markerIdx < 0) {
      markerIdx = 1;
      insert(markerIdx, 1 + lines.length + 1); // marker, lines, spacer
      summary.summaryCreated = true;
    } else {
      // Grow the block if it holds fewer lines than we write now (never shrink: no deletes).
      let existing = 0;
      while (markerIdx + 1 + existing < grid.length && cellStr(grid[markerIdx + 1 + existing]?.[0]) !== "" && !parseWeekLabel(grid[markerIdx + 1 + existing]?.[0] ?? null)) existing++;
      if (existing < lines.length) insert(markerIdx + 1 + existing, lines.length - existing);
    }
    write([{ row: markerIdx, col: IDX["A"]!, value: SUMMARY_MARKER }, ...lines.flatMap((l, i) => monthLineCells(markerIdx + 1 + i, l))]);
    style([{ row: markerIdx, style: "summary" }, ...lines.map((_, i) => ({ row: markerIdx + 1 + i, style: "summary" as RowStyleName }))]);
    firstBlockRow = markerIdx + 1 + lines.length + 1;
  }

  // ── Sales Pre-Approved / Unscheduled ──
  // Every sold job with no production date (the Sold Pipeline's Unscheduled
  // bucket, same rules), in a standing block under the month summary. A job
  // that gets scheduled leaves it and appears in its week; whatever the team
  // typed on its row here travels with it (`carry`). A leaving row is only
  // deleted once nothing hand-filled would be lost (phase B, after the weeks).
  const preOn = opts.preApproved ?? opts.monthSummary !== false;
  const today = opts.today ?? (opts.now ?? new Date()).toISOString().slice(0, 10);
  const carry = new Map<string, CellWrite[]>();
  const carriedTo = new Set<string>();
  const preLeaving = new Set<string>();
  const isBlankCell = (v: CellValue | undefined) => v === null || v === undefined || v === false || cellStr(v) === "" || cellStr(v).toUpperCase() === "FALSE";
  const preBlockRows = (labelIdx: number) => {
    const out: number[] = [];
    for (let i = labelIdx + 1; i < grid.length; i++) {
      const a = cellStr(grid[i]?.[0]);
      if (!a || parseWeekLabel(grid[i]?.[0] ?? null) || a === SUMMARY_MARKER) break;
      out.push(i);
    }
    return out;
  };
  if (preOn) {
    const pre = (opts.allRows ?? weeks.flatMap((w) => w.rows)).filter((r) => isPreApproved(r, today))
      .sort((a, b) => String(a.saleDate ?? "").localeCompare(String(b.saleDate ?? "")) || String(a.jobNumber ?? "").localeCompare(String(b.jobNumber ?? "")));
    const preIds = new Set(pre.map((r) => r.jobId));
    summary.preApproved = { created: false, jobs: pre.length, added: [], left: [], kept: [], carried: [] };
    let labelIdx = grid.findIndex((r, i) => i > 0 && cellStr(r?.[0]) === PREAPPROVED_LABEL);
    if (labelIdx < 0) {
      labelIdx = firstBlockRow;
      insert(labelIdx, 2); // label, spacer
      write([{ row: labelIdx, col: 0, value: PREAPPROVED_LABEL }]);
      summary.preApproved.created = true;
    }
    const have = new Map<string, number>();
    for (const idx of preBlockRows(labelIdx)) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
      if (!id) continue;                      // a row the team pasted: theirs, left alone
      if (preIds.has(id)) { have.set(id, idx); continue; }
      // Leaving: remember what the team typed, so the week row can carry it.
      preLeaving.add(id);
      const hand = HAND_COLUMNS.map((c) => ({ row: -1, col: ACTIVE[c.col]!, value: grid[idx]?.[ACTIVE[c.col]!] as CellValue }))
        .filter((x) => !isBlankCell(x.value));
      if (hand.length) carry.set(id, hand);
    }
    const adds: SheetRow[] = [];
    for (const r of pre) {
      const idx = have.get(r.jobId);
      if (idx !== undefined) { write(updateRowCells(idx, r, opts.syncedAt, grid[idx])); style(toneStyle(idx, r)); }
      else adds.push(r);
    }
    if (adds.length) {
      const at = labelIdx + 1 + preBlockRows(labelIdx).length;
      insert(at, adds.length);
      const cells: CellWrite[] = [];
      adds.forEach((r, i) => cells.push(...newRowCells(at + i, r, opts.syncedAt)));
      write(cells);
      style([...adds.map((_, i) => ({ row: at + i, style: "job" as const })), ...adds.flatMap((r, i) => toneStyle(at + i, r))]);
      summary.preApproved.added = adds.map((r) => r.label);
    }
    // A blank spacer after the block, then the weeks.
    let end = labelIdx + 1 + preBlockRows(labelIdx).length;
    if (end < grid.length && parseWeekLabel(grid[end]?.[0] ?? null)) insert(end, 1);
    firstBlockRow = end + 1;
  }
  /** A row for `jobId` at `rowIdx` also gets the cells the team typed on its pre-approved row. */
  const withCarry = (cells: CellWrite[], rowIdx: number, jobId: string, onlyEmpty: boolean): CellWrite[] => {
    const c = carry.get(jobId);
    if (!c) return cells;
    const add = c.filter((x) => !onlyEmpty || isBlankCell(grid[rowIdx]?.[x.col])).map((x) => ({ ...x, row: rowIdx }));
    carriedTo.add(jobId);
    const cols = new Set(add.map((x) => x.col));
    return [...cells.filter((x) => !(x.row === rowIdx && cols.has(x.col))), ...add];
  };

  const ordered = [...weeks].sort((a, b) => b.from.localeCompare(a.from)); // newest first, like the tab

  // Rows the team pasted from the old sheet carry no JobProgress ID, so they
  // are recognised by Job # (AC) or by Town/Address/Customer (A) instead —
  // and only when that key names exactly one job the feed is placing, so two
  // jobs at one address can never be confused. `norm` makes the comparison
  // blind to case and spacing.
  const norm = (v: CellValue | undefined) => cellStr(v).toLowerCase().replace(/\s+/g, " ").replace(/\/+$/, "").trim();
  const feedByKey = new Map<string, { row: SheetRow; from: string; to: string }[]>();
  for (const w of ordered) for (const r of w.rows) {
    for (const k of [r.jobNumber ? `#${norm(r.jobNumber)}` : null, r.label ? `@${norm(r.label)}` : null]) {
      if (!k) continue;
      (feedByKey.get(k) ?? feedByKey.set(k, []).get(k)!).push({ row: r, from: w.from, to: w.to });
    }
  }
  /** The one feed job a key names, or null when none or several. */
  const feedFor = (k: string) => { const hits = feedByKey.get(k) ?? []; return hits.length === 1 ? hits[0]! : null; };
  const rowKeys = (cells: CellValue[] | undefined) => [norm(cells?.[ACTIVE["AC"]!]) ? `#${norm(cells?.[ACTIVE["AC"]!])}` : null, norm(cells?.[0]) ? `@${norm(cells?.[0])}` : null].filter((k): k is string => !!k);

  // A week the tab still holds whole (9/28–10/4) that is now pushed in halves:
  // its block becomes the first half, relabelled in place, instead of the
  // halves being added beside it. Its other-month jobs move by the usual rules.
  {
    const relabels: CellWrite[] = [];
    for (const w of ordered) {
      const whole = weekBounds(w.from);
      if (w.from !== whole.from || w.to === whole.to) continue;          // not the first half of a split week
      const existing = parseBlocks(grid);
      if (existing.some((b) => b.from === w.from && b.to === w.to)) continue;
      const legacy = existing.find((b) => b.from === whole.from && b.to === whole.to);
      if (legacy) relabels.push({ row: legacy.labelIdx, col: 0, value: weekLabel(w.from, w.to) });
    }
    write(relabels);
    summary.weeksSplit = relabels.map((c) => String(c.value));
  }

  // A job whose week changed (its install moved, or a whole week was cut at
  // the month end): what the team typed on its old row travels to its row in
  // the new week, the same way it does for a job leaving the pre-approved
  // block, and the old row can then go instead of staying as a stamped twin.
  const weekMovers = new Set<string>();
  {
    const key = (from: string, to: string) => `${from}..${to}`;
    const placed = new Map<string, string>();
    for (const w of weeks) for (const r of w.rows) placed.set(r.jobId, key(w.from, w.to));
    const pushed = new Set(weeks.map((w) => key(w.from, w.to)));
    for (const b of parseBlocks(grid)) {
      if (!pushed.has(key(b.from, b.to))) continue;
      for (const idx of b.jobIdx) {
        const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
        const dest = id ? placed.get(id) : undefined;
        if (!dest || dest === key(b.from, b.to)) continue;
        weekMovers.add(id);
        const hand = HAND_COLUMNS.map((c) => ({ row: -1, col: ACTIVE[c.col]!, value: grid[idx]?.[ACTIVE[c.col]!] as CellValue }))
          .filter((x) => !isBlankCell(x.value));
        if (hand.length && !carry.has(id)) carry.set(id, hand);
      }
    }
  }

  for (const week of ordered) {
    const label = weekLabel(week.from, week.to);
    const rows = [...week.rows].sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? "") || (a.jobNumber ?? "").localeCompare(b.jobNumber ?? ""));
    const report = { label, existing: false, added: [] as string[], updated: [] as string[], notThisWeek: [] as string[], removed: [] as string[], adopted: [] as string[], elsewhere: [] as string[], unmatched: [] as string[] };
    let blocks = parseBlocks(grid);
    let block = blocks.find((b) => b.from === week.from && b.to === week.to) ?? null;

    if (!block) {
      // New block goes where date order puts it: before the first older week, else after the last block.
      const older = blocks.find((b) => b.from < week.from);
      const at = older ? older.labelIdx : blocks.length ? blockEnd(blocks[blocks.length - 1]!) + 2 : firstBlockRow;
      const count = 1 + rows.length + 1 + 1 + 1; // label, jobs, total, cumulative, spacer
      insert(at, count);
      const cells: CellWrite[] = [{ row: at, col: 0, value: label }];
      rows.forEach((r, i) => cells.push(...withCarry(newRowCells(at + 1 + i, r, opts.syncedAt), at + 1 + i, r.jobId, false)));
      // New job rows start white: an inserted row otherwise inherits the green of the total row next to it.
      style(rows.map((_, i) => ({ row: at + 1 + i, style: "job" as const })));
      const totalIdx = at + 1 + rows.length;
      cells.push(...totalRowCells(totalIdx, at + 1, at + rows.length));
      cells.push({ row: totalIdx + 1, col: 0, value: CUMULATIVE_LABEL }); // formulas come in the final pass
      write(cells);
      style([{ row: at, style: "label" }, { row: totalIdx, style: "total" }, { row: totalIdx + 1, style: "cumulative" }]);
      style(rows.flatMap((r, i) => toneStyle(at + 1 + i, r)));
      summary.blocksCreated.push(label);
      summary.jobsAdded += rows.length;
      report.added = rows.map((r) => r.label);
      summary.weeks.push(report);
      continue;
    }

    report.existing = true;
    const byJobId = new Map<string, number>();
    for (const idx of block.jobIdx) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
      if (id) byJobId.set(id, idx);
    }
    // ID-less rows in this block (pasted from the old sheet), by their keys — a key that
    // names two such rows is ambiguous and adopts neither.
    const unclaimed = new Map<string, number[]>();
    for (const idx of block.jobIdx) {
      if (cellStr(grid[idx]?.[JOB_ID_COL()])) continue;
      for (const k of rowKeys(grid[idx])) (unclaimed.get(k) ?? unclaimed.set(k, []).get(k)!).push(idx);
    }
    const claimed = new Set<number>();
    const adoptable = (k: string): number | undefined => {
      const hits = (unclaimed.get(k) ?? []).filter((i) => !claimed.has(i));
      // The key must name exactly one pasted row AND exactly one feed job.
      return hits.length === 1 && feedFor(k) ? hits[0] : undefined;
    };
    const seen = new Set<string>();
    const additions: SheetRow[] = [];
    for (const r of rows) {
      const idx = byJobId.get(r.jobId);
      if (idx !== undefined) {
        write(withCarry(updateRowCells(idx, r, opts.syncedAt, grid[idx]), idx, r.jobId, true));
        style(toneStyle(idx, r));
        summary.jobsUpdated++; report.updated.push(r.label); seen.add(r.jobId);
        continue;
      }
      // Take over a pasted row for this job rather than adding a twin beside it.
      const adopt = (r.jobNumber ? adoptable(`#${norm(r.jobNumber)}`) : undefined) ?? (r.label ? adoptable(`@${norm(r.label)}`) : undefined);
      if (adopt !== undefined) {
        claimed.add(adopt);
        write(withCarry(updateRowCells(adopt, r, opts.syncedAt, grid[adopt]), adopt, r.jobId, true));   // synced cells only — the team's cells on the row stay
        style(toneStyle(adopt, r));
        summary.jobsAdopted++; report.adopted.push(r.label); seen.add(r.jobId);
        continue;
      }
      additions.push(r);
    }
    if (additions.length) {
      // Before the Weekly Total row (or, if the block has none, right after its last job).
      const at = block.totalIdx ?? (block.jobIdx.length ? block.jobIdx[block.jobIdx.length - 1]! + 1 : block.labelIdx + 1);
      insert(at, additions.length);
      const cells: CellWrite[] = [];
      additions.forEach((r, i) => cells.push(...withCarry(newRowCells(at + i, r, opts.syncedAt), at + i, r.jobId, false)));
      write(cells);
      style([...additions.map((_, i) => ({ row: at + i, style: "job" as const })), ...additions.flatMap((r, i) => toneStyle(at + i, r))]);
      summary.jobsAdded += additions.length;
      report.added = additions.map((r) => r.label);
    }
    // Jobs on the block that the feed no longer places in this week: stamped, never removed.
    blocks = parseBlocks(grid);
    block = blocks.find((b) => b.from === week.from && b.to === week.to)!;
    // A job the feed no longer places in this week is a stale copy: usually
    // the install moved to another week, where the feed has already written
    // it. If the team typed or ticked anything on this row it is stamped and
    // kept, so nothing they wrote is lost. If every hand-filled column is
    // blank, there is nothing to lose and the row is removed.
    // Stamping is a VALUE in HY (and the sync time in HX), nothing more: the
    // row's formatting is the team's and is never touched.
    const stale: CellWrite[] = [];
    const toRemove: number[] = [];
    for (const idx of block.jobIdx) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
      if (id && !seen.has(id) && !additions.some((r) => r.jobId === id)) {
        const label = cellStr(grid[idx]?.[0]) || id;
        if (opts.removeEmptyStale && !hasHandFilled(grid[idx])) { toRemove.push(idx); summary.jobsRemoved++; report.removed.push(label); continue; }
        stale.push({ row: idx, col: ACTIVE["HY"]!, value: SYNC_STATUS_STALE });
        if (opts.syncedAt) stale.push({ row: idx, col: ACTIVE["HX"]!, value: dateTimeSerial(opts.syncedAt) });
        summary.jobsNotThisWeek++; report.notThisWeek.push(label);
      }
    }
    write(stale);
    // Bottom-up, so each index is still right when its turn comes; then re-read the block.
    for (const idx of toRemove.sort((a, b) => b - a)) remove(idx, 1);
    blocks = parseBlocks(grid);
    block = blocks.find((b) => b.from === week.from && b.to === week.to)!;

    // Pasted rows still without an ID. If the feed places that job in ANOTHER
    // week, JobProgress's install date wins: the row is stamped stale here (out
    // of this block's totals, so the revenue counts once, in its real week) and
    // given its ID so it behaves like any stale copy from now on. If the feed
    // does not know the job at all, it is flagged for the team.
    const orphan: CellWrite[] = [];
    for (const idx of block.jobIdx) {
      if (cellStr(grid[idx]?.[JOB_ID_COL()])) continue;
      const label = cellStr(grid[idx]?.[0]) || `row ${idx + 1}`;
      const hit = rowKeys(grid[idx]).map(feedFor).find((h) => h !== null) ?? null;
      if (hit && !(hit.from === week.from && hit.to === week.to)) {
        orphan.push({ row: idx, col: ACTIVE["HU"]!, value: hit.row.jobId });
        if (hit.row.jpUrl) orphan.push({ row: idx, col: ACTIVE["HV"]!, value: hit.row.jpUrl });
        orphan.push({ row: idx, col: ACTIVE["HY"]!, value: SYNC_STATUS_STALE });
        if (opts.syncedAt) orphan.push({ row: idx, col: ACTIVE["HX"]!, value: dateTimeSerial(opts.syncedAt) });
        summary.jobsElsewhere++; report.elsewhere.push(`${label} → ${weekLabel(hit.from, hit.to)}`);
      } else if (cellStr(grid[idx]?.[ACTIVE["HY"]!]) !== SYNC_STATUS_UNMATCHED) {
        orphan.push({ row: idx, col: ACTIVE["HY"]!, value: SYNC_STATUS_UNMATCHED });
        summary.jobsUnmatched++; report.unmatched.push(label);
      } else {
        summary.jobsUnmatched++; report.unmatched.push(label);
      }
    }
    write(orphan);
    // The total row's ranges follow the block as it grows.
    if (block.totalIdx !== null && block.jobIdx.length) {
      write(totalRowCells(block.totalIdx, block.jobIdx[0]!, block.jobIdx[block.jobIdx.length - 1]!));
    }
    // The tab's Cumulative Monthly Total row, added to a block that lacks it.
    if (block.totalIdx !== null && block.cumulativeIdx === null) {
      insert(block.totalIdx + 1, 1);
      write([{ row: block.totalIdx + 1, col: 0, value: CUMULATIVE_LABEL }]);
      style([{ row: block.totalIdx + 1, style: "cumulative" }]);
    }
    summary.weeks.push(report);
  }

  // Week moves, phase B: an old row whose typed cells were carried to the
  // job's row in its new week holds nothing that is not also there now.
  if (opts.removeEmptyStale && weekMovers.size) {
    const gone: number[] = [];
    for (const b of parseBlocks(grid)) for (const idx of b.jobIdx) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
      if (id && weekMovers.has(id) && carriedTo.has(id) && STALE_STATUSES.includes(cellStr(grid[idx]?.[ACTIVE["HY"]!]))) gone.push(idx);
    }
    for (const idx of gone.sort((a, b) => b - a)) remove(idx, 1);
    summary.jobsRemoved += gone.length;
    summary.jobsNotThisWeek -= gone.length;
  }

  // Pre-approved, phase B: rows that left. Deleted when nothing hand-filled
  // would be lost (none typed, or carried into the job's week row above);
  // otherwise kept and stamped so the team can move what they wrote. Then the
  // label row's totals, over whatever the block now holds.
  if (preOn && summary.preApproved) {
    const labelIdx = grid.findIndex((r, i) => i > 0 && cellStr(r?.[0]) === PREAPPROVED_LABEL);
    if (labelIdx >= 0) {
      const gone: number[] = [];
      const stamps: CellWrite[] = [];
      for (const idx of preBlockRows(labelIdx)) {
        const id = cellStr(grid[idx]?.[JOB_ID_COL()]);
        if (!id || !preLeaving.has(id)) continue;
        const label = cellStr(grid[idx]?.[0]) || id;
        if (!hasHandFilled(grid[idx]) || carriedTo.has(id)) {
          gone.push(idx); summary.preApproved.left.push(label);
          if (carriedTo.has(id)) summary.preApproved.carried.push(label);
        } else {
          if (cellStr(grid[idx]?.[ACTIVE["HY"]!]) !== SYNC_STATUS_LEFT_PREAPPROVED) stamps.push({ row: idx, col: ACTIVE["HY"]!, value: SYNC_STATUS_LEFT_PREAPPROVED });
          summary.preApproved.kept.push(label);
        }
      }
      write(stamps);
      for (const idx of gone.sort((a, b) => b - a)) remove(idx, 1);
      const rowsNow = preBlockRows(labelIdx);
      const totals: CellWrite[] = [{ row: labelIdx, col: 0, value: PREAPPROVED_LABEL }];
      for (const L of TOTALLED) {
        const col = IDX[L]!;
        totals.push({ row: labelIdx, col, value: rowsNow.length ? { formula: `SUM(${L}${rowsNow[0]! + 1}:${L}${rowsNow[rowsNow.length - 1]! + 1})` } : 0 });
      }
      write(totals);
      style([{ row: labelIdx, style: "label" }]);   // the block's own label row: yellow fill, black text
    }
  }

  // The planner's own rows — every week's label, Weekly Total and Cumulative —
  // are re-asserted each push, so rows written before text went black lose
  // their old green text. Job rows are never formatted (beyond PAID-IN-FULL).
  {
    const own: RowStyle[] = [];
    for (const b of parseBlocks(grid)) {
      own.push({ row: b.labelIdx, style: "label" });
      if (b.totalIdx !== null) own.push({ row: b.totalIdx, style: "total" });
      if (b.cumulativeIdx !== null) own.push({ row: b.cumulativeIdx, style: "cumulative" });
    }
    style(own);
  }

  // Cumulative Monthly Total rows last, once every block of the touched months
  // is in place: a new earlier week changes the later weeks' running totals too.
  const months = new Set(ordered.map((w) => monthOf(w.from)));
  for (const b of parseBlocks(grid)) if (months.has(monthOf(b.from))) writeCumulative(b.from);

  // The estimate / GP block, off the final grid so every row number is the one
  // the sheet will have once the inserts and deletes above have run.
  if (opts.costTotals) writeCostBlock(months);

  // Column B was a checkbox column: Google put TRUE/FALSE in every cell of
  // it, and dropping the rule left them showing as text on the rows the
  // feed never writes (week labels, totals, spacers, rows stamped as not
  // this week). Cleared, so the column reads YES / NO / blank. Job rows
  // written above already hold their answer and are not boolean any more.
  const pifCol = ACTIVE["B"]!;
  const boolish = (v: CellValue | undefined) => v === true || v === false || /^(true|false)$/i.test(cellStr(v));
  const leftovers: CellWrite[] = [];
  grid.forEach((r, i) => { if (i > 0 && boolish(r?.[pifCol])) leftovers.push({ row: i, col: pifCol, value: null }); });
  write(leftovers);
  summary.checkboxLeftoversCleared = leftovers.length;

  // Locks last, off the final grid, so the row spans are the ones the sheet
  // will have once every insert above has run. Every block past its Thursday
  // — not only the pushed weeks — so old weeks lock on the first run too.
  // The note sits in column B of the label row (A holds the label the parser
  // reads) and is written once; the protection itself is a sheet property
  // the push applies from `summary.locks`.
  if (opts.lockWeeks !== false) {
    summary.locks = lockedBlocks(grid, opts.today ?? (opts.now ?? new Date()).toISOString().slice(0, 10));
    const notes: CellWrite[] = [];
    for (const l of summary.locks) {
      const note = lockNote(l.from);
      if (cellStr(grid[l.startRow]?.[1]) !== note) notes.push({ row: l.startRow, col: 1, value: note });
    }
    write(notes);
  }
  return { ops, summary, grid };

  /** Rewrites the Cumulative Monthly Total formulas of the block for `from` from the blocks now on the tab. */
  function writeCumulative(from: string): void {
    const blocks = parseBlocks(grid);
    const me = blocks.find((b) => b.from === from);
    if (!me || me.totalIdx === null) return;
    const cumulativeIdx = me.cumulativeIdx ?? me.totalIdx + 1;
    // Older weeks of the same month sit below this block (the tab is newest-first).
    const older = blocks.filter((b) => monthOf(b.from) === monthOf(from) && b.from < from);
    const endRow = Math.max(cumulativeIdx, ...older.map(blockEnd));
    const ownJobs: [number, number] | null = me.totalIdx > me.labelIdx + 1 ? [me.labelIdx + 1, me.totalIdx - 1] : null;
    const below: [number, number] | null = endRow > cumulativeIdx ? [cumulativeIdx + 1, endRow] : null;
    write(cumulativeRowCells(cumulativeIdx, ownJobs, below));
  }

  /**
   * Estimate formulas on every job row of the touched months and the
   * pre-approved block, and estimate / actual totals on their Weekly Total,
   * Cumulative and Month at a Glance rows. Skipped, with the reason in the
   * summary, if any column it writes by letter does not carry its heading.
   */
  function writeCostBlock(touched: Set<string>): void {
    const hdr = grid[0] ?? [];
    const norm = (v: CellValue | undefined) => cellStr(v).toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
    for (const L of COST_BLOCK_COLS) {
      const want = COLS.find((c) => c.col === L)!.header;
      if (ACTIVE[L] !== IDX[L] || norm(hdr[IDX[L]!]) !== norm(want)) {
        summary.costBlock = { status: `skipped: column ${L} does not carry "${want}"`, jobRows: 0, totalRows: 0, monthRows: 0 };
        return;
      }
    }
    const taken = new Set(Object.values(ACTIVE));
    const byHeader = (name: string) => { const i = hdr.findIndex((v) => norm(v) === norm(name)); return i >= 0 && !taken.has(i) ? colLetter(i) : null; };
    const holdCol = byHeader(RECOGNITION_HEADER), jccCol = byHeader(FINAL_JCC_HEADER);
    const stale = (i: number) => STALE_STATUSES.includes(cellStr(grid[i]?.[ACTIVE["HY"]!]));
    const idOf = (i: number) => cellStr(grid[i]?.[JOB_ID_COL()]);
    const cells: CellWrite[] = [];
    const counts = { jobRows: 0, totalRows: 0, monthRows: 0 };
    const estimates = (i: number) => { counts.jobRows++; for (const [L, fn] of Object.entries(EST_JOB_FORMULAS)) cells.push({ row: i, col: IDX[L]!, value: { formula: fn(i + 1) } }); };
    const liveRows = (b: Block) => b.jobIdx.filter((i) => !stale(i));

    const blocks = parseBlocks(grid);
    for (const b of blocks) {
      if (!touched.has(monthOf(b.from))) continue;
      b.jobIdx.forEach(estimates);
      if (b.totalIdx !== null) { cells.push(...costTotalCells(b.totalIdx, liveRows(b), holdCol, jccCol)); counts.totalRows++; }
      if (b.cumulativeIdx !== null) {
        // This week and the earlier weeks of its month, each job once (a job can sit in two blocks).
        const seen = new Set<string>(), rows: number[] = [];
        for (const o of blocks.filter((x) => monthOf(x.from) === monthOf(b.from) && x.from <= b.from)) {
          for (const i of liveRows(o)) { const id = idOf(i); if (id) { if (seen.has(id)) continue; seen.add(id); } rows.push(i); }
        }
        cells.push(...costTotalCells(b.cumulativeIdx, rows, holdCol, jccCol)); counts.totalRows++;
      }
    }
    const preLabel = grid.findIndex((r, i) => i > 0 && cellStr(r?.[0]) === PREAPPROVED_LABEL);
    if (preLabel >= 0) preBlockRows(preLabel).forEach(estimates);

    // Month at a Glance: the same jobs the line counts, at their row in the week their install starts.
    const markerIdx = grid.findIndex((r, i) => i > 0 && cellStr(r?.[0]) === SUMMARY_MARKER);
    if (opts.monthSummary !== false && markerIdx >= 0) {
      const all = opts.allRows ?? weeks.flatMap((w) => w.rows);
      const rowOf = new Map<string, number>();
      for (const b of blocks) for (const i of liveRows(b)) {
        const id = idOf(i); if (!id) continue;
        const job = all.find((r) => r.jobId === id); const first = job ? firstInstallDay(job) : null;
        if (!rowOf.has(id) || (first && first >= b.from && first <= b.to)) rowOf.set(id, i);
      }
      const thisMonth = monthOf(today);
      const [y, m] = thisMonth.split("-").map(Number);
      const prevMonth = `${m === 1 ? y! - 1 : y}-${String(m === 1 ? 12 : m! - 1).padStart(2, "0")}`;
      let line = markerIdx + 1;
      for (const ym of [thisMonth, prevMonth]) {
        const projected = all.filter((r) => { const d = firstInstallDay(r); return d !== null && monthOf(d) === ym; });
        const started = projected.filter((r) => firstInstallDay(r)! <= today && STARTED_STAGES.has(stageKey(r.stage)));
        for (const set of [projected, started]) {
          if (!cellStr(grid[line]?.[0]).startsWith(monthTitle(ym))) { line++; continue; }
          const rows = set.map((r) => rowOf.get(r.jobId)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
          cells.push(...costTotalCells(line, rows, holdCol, jccCol)); counts.monthRows++;
          line++;
        }
      }
    }
    write(cells);
    summary.costBlock = { status: `written${holdCol ? `; HOLD from ${holdCol}` : "; no Recognition column yet"}${jccCol ? `; Final JCC from ${jccCol}` : "; no Final Job Costing Complete column"}`, ...counts };
  }
  }
}

/**
 * A sold job ready to schedule — the Sold Pipeline's "Ready to schedule" card,
 * by the same shared rules, read off a sheet row: signed, not paid, not dead,
 * no install visit, and in one of the production manager's ready stages.
 */
export function isPreApproved(r: SheetRow, today: string): boolean {
  const job = { contractSignedDate: r.saleDate, stage: r.stage, installDays: [...new Set((r.visits ?? []).filter((v) => isInstallCode(v.code)).map((v) => v.day))].sort() };
  // Ready to schedule only: jobs parked on credit, a carrier or a deposit stay on the Sold Pipeline page.
  return inPipeline(job) && bucketFor(job, today) === "unscheduled" && isReadyStage(r.stage);
}

export { weekBounds };
