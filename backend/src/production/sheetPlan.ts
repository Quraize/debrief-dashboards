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
import { MASTER_COLUMNS, columnFormula, weekLabel } from "@allied/shared/weeklyJobSheetMaster";
import { isInstallCode } from "@allied/shared/production";
import { stageKey } from "@allied/shared/jobStages";
import type { SheetRow } from "./weeklyJobSheet.js";
import type { CellValue } from "../integrations/google/sheets.js";

type Column = { col: string; header: string; key?: string; type: string; hidden?: boolean; list?: string[]; formula?: string; fill?: string | null };

export interface WeekInput { from: string; to: string; rows: SheetRow[] }

export interface CellWrite { row: number; col: number; value: CellValue | { formula: string } }
export type RowStyleName = "label" | "total" | "cumulative" | "summary";
export interface RowStyle { row: number; style: RowStyleName }
export type PlanOp =
  | { type: "insertRows"; at: number; count: number }
  | { type: "write"; cells: CellWrite[] }
  | { type: "style"; rows: RowStyle[] };

export interface PlanSummary {
  headerCreated: boolean;
  summaryCreated: boolean;
  blocksCreated: string[];
  jobsAdded: number;
  jobsUpdated: number;
  jobsNotThisWeek: number;
  cellsWritten: number;
  /** Per week: what happened, for the dry-run report. */
  weeks: { label: string; existing: boolean; added: string[]; updated: string[]; notThisWeek: string[] }[];
  /** The month lines as written, for the dry-run report. */
  months: { label: string; jobs: number; gross: number }[];
}

export interface Plan { ops: PlanOp[]; summary: PlanSummary }

export const SYNC_STATUS_OK = "Synced from JobProgress";
export const SYNC_STATUS_STALE = "Not on the JobProgress calendar this week";
export const SUMMARY_MARKER = "MONTH AT A GLANCE";
export const CUMULATIVE_LABEL = "Cumulative Monthly Total";

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
const JOB_ID_COL = IDX["HU"]!;
const TOTALLED = ["R", "S", "T", "Y", "Z", "AA", "AB"];

const cellStr = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v).trim());

/** The value a synced column takes for a row; null = leave blank. */
export function syncedValue(column: Column, row: SheetRow, syncedAt: string | null): CellValue | { formula: string } | null {
  if (column.formula) return null; // formulas are placed by rowValues, they need the row number
  if (!column.key) return null;
  if (column.key === "syncedAt") return syncedAt ? dateTimeSerial(syncedAt) : null;
  if (column.key === "syncStatus") return SYNC_STATUS_OK;
  const v = (row as unknown as Record<string, unknown>)[column.key];
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
    const col = IDX[c.col]!;
    const formula = columnFormula(c, rowIdx + 1);
    if (formula) { out.push({ row: rowIdx, col, value: { formula } }); continue; }
    const v = syncedValue(c, row, syncedAt);
    if (v !== null) out.push({ row: rowIdx, col, value: v });
    else if (c.type === "check") out.push({ row: rowIdx, col, value: false });
  }
  return out;
}

/** Only the synced columns of an existing row — the team's cells stay as they are. */
function updateRowCells(rowIdx: number, row: SheetRow, syncedAt: string | null): CellWrite[] {
  const out: CellWrite[] = [];
  for (const c of COLS) {
    if (!c.key) continue;
    const v = syncedValue(c, row, syncedAt);
    if (v !== null) out.push({ row: rowIdx, col: IDX[c.col]!, value: v });
  }
  return out;
}

function totalRowCells(rowIdx: number, firstJob: number, lastJob: number): CellWrite[] {
  const out: CellWrite[] = [{ row: rowIdx, col: IDX["A"]!, value: "Weekly Total" }];
  for (const L of TOTALLED) {
    const value = lastJob >= firstJob ? { formula: `SUM(${L}${firstJob + 1}:${L}${lastJob + 1})` } : 0;
    out.push({ row: rowIdx, col: IDX[L]!, value });
  }
  return out;
}

/** This week's total plus the totals of the same month's earlier weeks already on the tab. */
function cumulativeRowCells(rowIdx: number, totalRows: number[]): CellWrite[] {
  const out: CellWrite[] = [{ row: rowIdx, col: IDX["A"]!, value: CUMULATIVE_LABEL }];
  for (const L of TOTALLED) {
    out.push({ row: rowIdx, col: IDX[L]!, value: { formula: totalRows.map((r) => `${L}${r + 1}`).join("+") } });
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
    if (/^cumulative monthly total$/i.test(text)) { const last = blocks[blocks.length - 1]; if (last && last.totalIdx !== null && last.cumulativeIdx === null) last.cumulativeIdx = i; continue; }
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

export interface MonthLine { label: string; jobs: number; gross: number; totalRev: number; deposit: number; paid: number; owed: number }

/**
 * Two lines per month, for the month `today` is in and the month before it:
 *   Projected — jobs with an install visit scheduled in the month;
 *   Started   — of those, jobs whose install day has passed and whose stage
 *               says production started (or later).
 */
export function monthLines(rows: SheetRow[], today: string): MonthLine[] {
  const thisMonth = monthOf(today);
  const [y, m] = thisMonth.split("-").map(Number);
  const prevMonth = `${m === 1 ? y! - 1 : y}-${String(m === 1 ? 12 : m! - 1).padStart(2, "0")}`;
  const out: MonthLine[] = [];
  for (const ym of [thisMonth, prevMonth]) {
    const installsIn = (r: SheetRow) => r.visits.filter((v) => isInstallCode(v.code) && monthOf(v.day) === ym);
    const projected = rows.filter((r) => installsIn(r).length > 0);
    const started = projected.filter((r) => installsIn(r).some((v) => v.day <= today) && STARTED_STAGES.has(stageKey(r.stage)));
    const sum = (set: SheetRow[], key: keyof SheetRow) => Math.round(set.reduce((n, r) => n + (Number(r[key]) || 0), 0) * 100) / 100;
    const line = (kind: string, set: SheetRow[], what: string): MonthLine => ({
      label: `${monthTitle(ym)} — ${kind}: ${set.length} job${set.length === 1 ? "" : "s"} ${what}, ${money(sum(set, "totalRev"))}`,
      jobs: set.length, gross: sum(set, "gross"), totalRev: sum(set, "totalRev"), deposit: sum(set, "deposit"), paid: sum(set, "totalPayments"), owed: sum(set, "balanceOwed"),
    });
    out.push(line("Projected", projected, "with an install scheduled this month"));
    out.push(line("Started", started, "with the install started (in production)"));
  }
  return out;
}

function monthLineCells(rowIdx: number, l: MonthLine): CellWrite[] {
  return [
    { row: rowIdx, col: IDX["A"]!, value: l.label },
    { row: rowIdx, col: IDX["R"]!, value: l.gross },
    { row: rowIdx, col: IDX["T"]!, value: l.totalRev },
    { row: rowIdx, col: IDX["Y"]!, value: l.deposit },
    { row: rowIdx, col: IDX["AA"]!, value: l.paid },
    { row: rowIdx, col: IDX["AB"]!, value: l.owed },
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
}

export function planSheet(gridIn: CellValue[][], weeks: WeekInput[], opts: PlanOptions): Plan {
  // Work on a copy: row insertions shift indices, and the emitted operations
  // must use the indices the sheet will have at the moment each one runs.
  const grid: CellValue[][] = gridIn.map((r) => [...r]);
  const ops: PlanOp[] = [];
  const summary: PlanSummary = {
    headerCreated: false, summaryCreated: false, blocksCreated: [], jobsAdded: 0, jobsUpdated: 0, jobsNotThisWeek: 0, cellsWritten: 0, weeks: [], months: [],
  };
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
  const style = (rows: RowStyle[]) => { if (rows.length) ops.push({ type: "style", rows }); };

  // Header: written when the tab is empty or row 1 is blank.
  if (grid.length === 0 || cellStr(grid[0]?.[0]) === "" && cellStr(grid[0]?.[1]) === "") {
    if (grid.length === 0) grid.push([]);
    write(COLS.map((c) => ({ row: 0, col: IDX[c.col]!, value: c.header })));
    summary.headerCreated = true;
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

  const ordered = [...weeks].sort((a, b) => b.from.localeCompare(a.from)); // newest first, like the tab
  for (const week of ordered) {
    const label = weekLabel(week.from, week.to);
    const rows = [...week.rows].sort((a, b) => (b.saleDate ?? "").localeCompare(a.saleDate ?? "") || (a.jobNumber ?? "").localeCompare(b.jobNumber ?? ""));
    const report = { label, existing: false, added: [] as string[], updated: [] as string[], notThisWeek: [] as string[] };
    let blocks = parseBlocks(grid);
    let block = blocks.find((b) => b.from === week.from && b.to === week.to) ?? null;

    if (!block) {
      // New block goes where date order puts it: before the first older week, else after the last block.
      const older = blocks.find((b) => b.from < week.from);
      const at = older ? older.labelIdx : blocks.length ? blockEnd(blocks[blocks.length - 1]!) + 2 : firstBlockRow;
      const count = 1 + rows.length + 1 + 1 + 1; // label, jobs, total, cumulative, spacer
      insert(at, count);
      const cells: CellWrite[] = [{ row: at, col: 0, value: label }];
      rows.forEach((r, i) => cells.push(...newRowCells(at + 1 + i, r, opts.syncedAt)));
      const totalIdx = at + 1 + rows.length;
      cells.push(...totalRowCells(totalIdx, at + 1, at + rows.length));
      cells.push({ row: totalIdx + 1, col: 0, value: CUMULATIVE_LABEL }); // formulas come in the final pass
      write(cells);
      style([{ row: at, style: "label" }, { row: totalIdx, style: "total" }, { row: totalIdx + 1, style: "cumulative" }]);
      summary.blocksCreated.push(label);
      summary.jobsAdded += rows.length;
      report.added = rows.map((r) => r.label);
      summary.weeks.push(report);
      continue;
    }

    report.existing = true;
    const byJobId = new Map<string, number>();
    for (const idx of block.jobIdx) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL]);
      if (id) byJobId.set(id, idx);
    }
    const seen = new Set<string>();
    const additions: SheetRow[] = [];
    for (const r of rows) {
      const idx = byJobId.get(r.jobId);
      if (idx !== undefined) {
        write(updateRowCells(idx, r, opts.syncedAt));
        summary.jobsUpdated++; report.updated.push(r.label); seen.add(r.jobId);
      } else {
        additions.push(r);
      }
    }
    if (additions.length) {
      // Before the Weekly Total row (or, if the block has none, right after its last job).
      const at = block.totalIdx ?? (block.jobIdx.length ? block.jobIdx[block.jobIdx.length - 1]! + 1 : block.labelIdx + 1);
      insert(at, additions.length);
      const cells: CellWrite[] = [];
      additions.forEach((r, i) => cells.push(...newRowCells(at + i, r, opts.syncedAt)));
      write(cells);
      summary.jobsAdded += additions.length;
      report.added = additions.map((r) => r.label);
    }
    // Jobs on the block that the feed no longer places in this week: stamped, never removed.
    blocks = parseBlocks(grid);
    block = blocks.find((b) => b.from === week.from && b.to === week.to)!;
    const stale: CellWrite[] = [];
    for (const idx of block.jobIdx) {
      const id = cellStr(grid[idx]?.[JOB_ID_COL]);
      if (id && !seen.has(id) && !additions.some((r) => r.jobId === id)) {
        stale.push({ row: idx, col: IDX["HY"]!, value: SYNC_STATUS_STALE });
        if (opts.syncedAt) stale.push({ row: idx, col: IDX["HX"]!, value: dateTimeSerial(opts.syncedAt) });
        summary.jobsNotThisWeek++; report.notThisWeek.push(cellStr(grid[idx]?.[0]) || id);
      }
    }
    write(stale);
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

  // Cumulative Monthly Total rows last, once every block of the touched months
  // is in place: a new earlier week changes the later weeks' running totals too.
  const months = new Set(ordered.map((w) => monthOf(w.from)));
  for (const b of parseBlocks(grid)) if (months.has(monthOf(b.from))) writeCumulative(b.from);
  return { ops, summary };

  /** Rewrites the Cumulative Monthly Total formulas of the block for `from` from the blocks now on the tab. */
  function writeCumulative(from: string): void {
    const blocks = parseBlocks(grid);
    const me = blocks.find((b) => b.from === from);
    if (!me || me.totalIdx === null) return;
    const cumulativeIdx = me.cumulativeIdx ?? me.totalIdx + 1;
    const sameMonth = blocks.filter((b) => b.totalIdx !== null && monthOf(b.from) === monthOf(from) && b.from <= from);
    write(cumulativeRowCells(cumulativeIdx, sameMonth.map((b) => b.totalIdx!).sort((a, b) => a - b)));
  }
}

/** Monday..Sunday (office calendar) of the week containing `day`, plus `offset` weeks. */
export function weekBounds(day: string, offset = 0): { from: string; to: string } {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  const dow = (base.getUTCDay() + 6) % 7; // Monday = 0
  const mon = new Date(base.getTime() - dow * 86_400_000 + offset * 7 * 86_400_000);
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const f = (x: Date) => x.toISOString().slice(0, 10);
  return { from: f(mon), to: f(sun) };
}
