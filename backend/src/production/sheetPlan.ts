/**
 * Plans the changes that bring the [AUTOMATION] WEEKLY JOB SHEET tab in line
 * with the feed, as a pure function of what the tab holds now and what the
 * feed says — nothing here talks to Google, so the rules are testable and a
 * dry run is the same code with the writes left unsent.
 *
 * The tab is the team's. The planner therefore:
 *   - recognises the tab's structure (header, "M/D/YYYY-M/D/YYYY" week label
 *     rows, job rows, "Weekly Total" rows), newest week at the top;
 *   - recognises a job row by the JobProgress Job ID in column HU, and on an
 *     existing row rewrites ONLY the synced columns — checkboxes, notes and
 *     every other hand-filled cell are never touched;
 *   - adds a missing week as a new block in date order, and a missing job as a
 *     new row at the end of its week's block (before the Weekly Total);
 *   - never deletes: a job the feed no longer places in a week is stamped in
 *     the hidden JP Sync Status column instead.
 */
import { MASTER_COLUMNS, columnFormula, weekLabel } from "@allied/shared/weeklyJobSheetMaster";
import type { SheetRow } from "./weeklyJobSheet.js";
import type { CellValue } from "../integrations/google/sheets.js";

type Column = { col: string; header: string; key?: string; type: string; hidden?: boolean; list?: string[]; formula?: string; fill?: string | null };

export interface WeekInput { from: string; to: string; rows: SheetRow[] }

export interface CellWrite { row: number; col: number; value: CellValue | { formula: string } }
export interface RowStyle { row: number; style: "label" | "total" }
export type PlanOp =
  | { type: "insertRows"; at: number; count: number }
  | { type: "write"; cells: CellWrite[] }
  | { type: "style"; rows: RowStyle[] };

export interface PlanSummary {
  headerCreated: boolean;
  blocksCreated: string[];
  jobsAdded: number;
  jobsUpdated: number;
  jobsNotThisWeek: number;
  cellsWritten: number;
  /** Per week: what happened, for the dry-run report. */
  weeks: { label: string; existing: boolean; added: string[]; updated: string[]; notThisWeek: string[] }[];
}

export interface Plan { ops: PlanOp[]; summary: PlanSummary }

export const SYNC_STATUS_OK = "Synced from JobProgress";
export const SYNC_STATUS_STALE = "Not on the JobProgress calendar this week";

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

interface Block { labelIdx: number; from: string; to: string; jobIdx: number[]; totalIdx: number | null }

/** Reads the tab's week blocks off the grid. */
export function parseBlocks(grid: CellValue[][]): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  for (let i = 1; i < grid.length; i++) {
    const a = grid[i]?.[0] ?? null;
    const label = parseWeekLabel(a);
    if (label) { cur = { labelIdx: i, ...label, jobIdx: [], totalIdx: null }; blocks.push(cur); continue; }
    if (!cur) continue;
    if (/^weekly total$/i.test(cellStr(a))) { cur.totalIdx = i; cur = null; continue; }
    const rowHasContent = (grid[i] ?? []).some((v) => cellStr(v) !== "" && v !== false);
    if (rowHasContent) cur.jobIdx.push(i);
  }
  return blocks;
}

export interface PlanOptions { now?: Date; syncedAt: string | null }

export function planSheet(gridIn: CellValue[][], weeks: WeekInput[], opts: PlanOptions): Plan {
  // Work on a copy: row insertions shift indices, and the emitted operations
  // must use the indices the sheet will have at the moment each one runs.
  const grid: CellValue[][] = gridIn.map((r) => [...r]);
  const ops: PlanOp[] = [];
  const summary: PlanSummary = { headerCreated: false, blocksCreated: [], jobsAdded: 0, jobsUpdated: 0, jobsNotThisWeek: 0, cellsWritten: 0, weeks: [] };
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

  // Header: written when the tab is empty or row 1 is blank.
  if (grid.length === 0 || cellStr(grid[0]?.[0]) === "" && cellStr(grid[0]?.[1]) === "") {
    if (grid.length === 0) grid.push([]);
    write(COLS.map((c) => ({ row: 0, col: IDX[c.col]!, value: c.header })));
    summary.headerCreated = true;
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
      const at = older ? older.labelIdx : blocks.length ? (blocks[blocks.length - 1]!.totalIdx ?? blocks[blocks.length - 1]!.labelIdx) + 2 : 1;
      const count = 1 + rows.length + 1 + 1; // label, jobs, total, spacer
      insert(at, count);
      const cells: CellWrite[] = [{ row: at, col: 0, value: label }];
      rows.forEach((r, i) => cells.push(...newRowCells(at + 1 + i, r, opts.syncedAt)));
      cells.push(...totalRowCells(at + 1 + rows.length, at + 1, at + rows.length));
      write(cells);
      ops.push({ type: "style", rows: [{ row: at, style: "label" }, { row: at + 1 + rows.length, style: "total" }] });
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
    summary.weeks.push(report);
  }
  return { ops, summary };
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
