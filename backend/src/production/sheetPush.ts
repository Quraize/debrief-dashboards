/**
 * Pushes the Weekly Job Sheet into the production master sheet's
 * [AUTOMATION]WEEKLY JOB SHEET tab in Google Sheets.
 *
 * Read the tab → plan (sheetPlan.ts, pure) → apply the plan as one ordered
 * batchUpdate. The first push onto an empty tab also lays the tab out like the
 * team's: header colours, widths, hidden columns, real checkboxes on the
 * checkbox columns, the tab's dropdowns, money/date formats, frozen header.
 *
 * Which weeks: the current office week, SHEET_PUSH_WEEKS_BACK weeks before it
 * (money keeps changing after install) and SHEET_PUSH_WEEKS_AHEAD after it (the
 * team pre-creates upcoming weeks). A week's jobs are the feed's install rule.
 *
 * A dry run performs the read and the plan and reports what would change.
 */
import { withServiceRole } from "../db/client.js";
import { GoogleSheetsClient, a1, type CellValue } from "../integrations/google/sheets.js";
import { MASTER_COLUMNS, FILLS, NUM_FMT } from "@allied/shared/weeklyJobSheetMaster";
import { weeklyJobSheetAsService, filterSheetRows, type SheetRow } from "./weeklyJobSheet.js";
import { planSheet, weekBounds, colIndex, type Plan, type PlanOp, type WeekInput } from "./sheetPlan.js";
import { BOARD_TIMEZONE } from "./board.js";

export const DEFAULT_TAB = "[AUTOMATION]WEEKLY JOB SHEET";
const FORMAT_ROWS = 5000; // formats/validation cover this many rows; inserted rows fall inside

export interface SheetPushSettings {
  enabled: boolean; reason: string; tab: string; spreadsheetId: string | null;
  weeksBack: number; weeksAhead: number; cron: string;
}

export function sheetPushSettings(): SheetPushSettings {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim() || null;
  const hasKey = !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  const tab = process.env.GOOGLE_SHEETS_TAB?.trim() || DEFAULT_TAB;
  const base = {
    tab, spreadsheetId,
    weeksBack: Number(process.env.SHEET_PUSH_WEEKS_BACK ?? 1),
    weeksAhead: Number(process.env.SHEET_PUSH_WEEKS_AHEAD ?? 3),
    cron: process.env.SHEET_PUSH_CRON ?? "20 * * * *",
  };
  if (!hasKey) return { ...base, enabled: false, reason: "GOOGLE_SERVICE_ACCOUNT_JSON not set" };
  if (!spreadsheetId) return { ...base, enabled: false, reason: "GOOGLE_SHEETS_SPREADSHEET_ID not set" };
  if (process.env.SHEET_PUSH_ENABLED === "false") return { ...base, enabled: false, reason: "SHEET_PUSH_ENABLED is false" };
  return { ...base, enabled: true, reason: "" };
}

export interface SheetPushOptions {
  dryRun: boolean;
  startedBy: string;
  weeksBack?: number;
  weeksAhead?: number;
  client?: GoogleSheetsClient;
  now?: Date;
  /** Injected in tests; the feed otherwise. */
  feed?: () => Promise<{ rows: SheetRow[]; sync: { finishedAt: string | null; startedAt: string } | null }>;
}

export interface SheetPushResult {
  syncRunId: string | null;
  status: "completed" | "failed" | "skipped";
  dryRun: boolean;
  tab: string;
  weeks: string[];
  summary: Plan["summary"] | null;
  requests: number;
  errorMessage?: string;
}

const officeDay = (d: Date) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BOARD_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

export async function pushWeeklyJobSheet(options: SheetPushOptions): Promise<SheetPushResult> {
  const settings = sheetPushSettings();
  const client = options.client ?? GoogleSheetsClient.fromEnv();
  const now = options.now ?? new Date();
  const weeksBack = options.weeksBack ?? settings.weeksBack;
  const weeksAhead = options.weeksAhead ?? settings.weeksAhead;
  if (!client) {
    return { syncRunId: null, status: "skipped", dryRun: options.dryRun, tab: settings.tab, weeks: [], summary: null, requests: 0, errorMessage: settings.reason };
  }

  const syncRunId = await openRun(options.dryRun, options.startedBy);
  try {
    const sheetId = await client.sheetIdByTitle(settings.tab);
    if (sheetId === null) throw new Error(`Tab "${settings.tab}" not found in the spreadsheet (check the tab name and that the sheet is shared with the service account)`);

    const feed = await (options.feed ?? weeklyJobSheetAsService)();
    const today = officeDay(now);
    const weeks: WeekInput[] = [];
    for (let k = -weeksBack; k <= weeksAhead; k++) {
      const b = weekBounds(today, k);
      weeks.push({ ...b, rows: filterSheetRows(feed.rows, { from: b.from, to: b.to, basis: "install" }) });
    }

    const grid = await client.getValues(a1(settings.tab, "A1:HZ"));
    const plan = planSheet(grid, weeks, { now, syncedAt: feed.sync?.finishedAt ?? feed.sync?.startedAt ?? null });
    const requests = toRequests(plan, sheetId);
    if (!options.dryRun && requests.length) await client.batchUpdate(requests);

    const weekLabels = plan.summary.weeks.map((w) => w.label);
    await closeRun(syncRunId, "completed", { dryRun: options.dryRun, requests: requests.length, ...plan.summary });
    console.info(`[sheet-push] ${options.dryRun ? "dry run" : "pushed"}: ${plan.summary.jobsAdded} added, ${plan.summary.jobsUpdated} updated, `
      + `${plan.summary.blocksCreated.length} week block(s) created, ${requests.length} request(s)`);
    return { syncRunId, status: "completed", dryRun: options.dryRun, tab: settings.tab, weeks: weekLabels, summary: plan.summary, requests: requests.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await closeRun(syncRunId, "failed", { dryRun: options.dryRun }, message);
    return { syncRunId, status: "failed", dryRun: options.dryRun, tab: settings.tab, weeks: [], summary: null, requests: 0, errorMessage: message };
  }
}

// ── Plan → Sheets API requests ──────────────────────────────────────────────

type Column = { col: string; header: string; key?: string; type: string; width: number; fill: string | null; hidden?: boolean; list?: string[] };
const COLS = MASTER_COLUMNS as Column[];

const rgb = (hex: string) => {
  const h = hex.length === 8 ? hex.slice(2) : hex; // ARGB → RGB
  return { red: parseInt(h.slice(0, 2), 16) / 255, green: parseInt(h.slice(2, 4), 16) / 255, blue: parseInt(h.slice(4, 6), 16) / 255 };
};
const NUMBER_FORMAT: Record<string, { type: string; pattern: string }> = {
  money: { type: "CURRENCY", pattern: NUM_FMT.money },
  pct: { type: "PERCENT", pattern: NUM_FMT.pct },
  date: { type: "DATE", pattern: NUM_FMT.date },
  datetime: { type: "DATE_TIME", pattern: NUM_FMT.datetime },
};

function cellData(value: CellValue | { formula: string }): Record<string, unknown> {
  if (value === null || value === undefined) return { userEnteredValue: null };
  if (typeof value === "object") return { userEnteredValue: { formulaValue: `=${value.formula}` } };
  if (typeof value === "boolean") return { userEnteredValue: { boolValue: value } };
  if (typeof value === "number") return { userEnteredValue: { numberValue: value } };
  return { userEnteredValue: { stringValue: value } };
}

/** The tab's layout, applied once when the header is created. */
export function setupRequests(sheetId: number): unknown[] {
  const reqs: unknown[] = [];
  reqs.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 } }, fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount" } });
  for (const c of COLS) {
    const col = colIndex(c.col);
    const colRange = { sheetId, dimension: "COLUMNS", startIndex: col, endIndex: col + 1 };
    reqs.push({ updateDimensionProperties: { range: colRange, properties: { pixelSize: Math.round(c.width * 7.5), hiddenByUser: !!c.hidden }, fields: "pixelSize,hiddenByUser" } });
    const headerFmt: Record<string, unknown> = {
      textFormat: { bold: true, fontSize: 8, foregroundColor: c.fill === "ledger" || c.fill === "navy" ? rgb("FFFFFF") : rgb("000000") },
      horizontalAlignment: "CENTER", verticalAlignment: "BOTTOM", wrapStrategy: "WRAP",
    };
    if (c.fill) headerFmt["backgroundColor"] = rgb((FILLS as Record<string, string>)[c.fill]!);
    reqs.push({ repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: col, endColumnIndex: col + 1 }, cell: { userEnteredFormat: headerFmt }, fields: "userEnteredFormat(textFormat,horizontalAlignment,verticalAlignment,wrapStrategy,backgroundColor)" } });
    const body = { sheetId, startRowIndex: 1, endRowIndex: FORMAT_ROWS, startColumnIndex: col, endColumnIndex: col + 1 };
    if (c.type === "check") {
      reqs.push({ setDataValidation: { range: body, rule: { condition: { type: "BOOLEAN" }, showCustomUi: true, strict: true } } });
    } else if (c.list) {
      reqs.push({ setDataValidation: { range: body, rule: { condition: { type: "ONE_OF_LIST", values: c.list.map((v) => ({ userEnteredValue: v })) }, showCustomUi: true, strict: false } } });
    }
    const nf = NUMBER_FORMAT[c.type];
    if (nf) reqs.push({ repeatCell: { range: body, cell: { userEnteredFormat: { numberFormat: nf } }, fields: "userEnteredFormat.numberFormat" } });
  }
  reqs.push({ updateDimensionProperties: { range: { sheetId, dimension: "ROWS", startIndex: 0, endIndex: 1 }, properties: { pixelSize: 40 }, fields: "pixelSize" } });
  return reqs;
}

const LABEL_STYLE = { backgroundColor: rgb("FFFF00"), textFormat: { bold: true, fontSize: 8, foregroundColor: rgb("34A853") } };
const TOTAL_STYLE = { backgroundColor: rgb("D1F1DA"), textFormat: { bold: true, fontSize: 8 } };

export function toRequests(plan: Plan, sheetId: number): unknown[] {
  const reqs: unknown[] = [];
  if (plan.summary.headerCreated) reqs.push(...setupRequests(sheetId));
  const lastCol = colIndex("HZ") + 1;
  for (const op of plan.ops) opRequests(op, sheetId, lastCol, reqs);
  return reqs;
}

function opRequests(op: PlanOp, sheetId: number, lastCol: number, reqs: unknown[]): void {
  if (op.type === "insertRows") {
    reqs.push({ insertDimension: { range: { sheetId, dimension: "ROWS", startIndex: op.at, endIndex: op.at + op.count }, inheritFromBefore: false } });
    return;
  }
  if (op.type === "style") {
    for (const r of op.rows) {
      reqs.push({ repeatCell: {
        range: { sheetId, startRowIndex: r.row, endRowIndex: r.row + 1, startColumnIndex: 0, endColumnIndex: lastCol },
        cell: { userEnteredFormat: r.style === "label" ? LABEL_STYLE : TOTAL_STYLE },
        fields: "userEnteredFormat(backgroundColor,textFormat)",
      } });
    }
    return;
  }
  // Writes: one updateCells per run of adjacent cells on a row, so nothing
  // between two written cells is ever cleared.
  const byRow = new Map<number, { col: number; value: CellValue | { formula: string } }[]>();
  for (const c of op.cells) (byRow.get(c.row) ?? byRow.set(c.row, []).get(c.row)!).push({ col: c.col, value: c.value });
  for (const [row, cells] of byRow) {
    cells.sort((a, b) => a.col - b.col);
    let i = 0;
    while (i < cells.length) {
      let j = i;
      while (j + 1 < cells.length && cells[j + 1]!.col === cells[j]!.col + 1) j++;
      reqs.push({ updateCells: {
        start: { sheetId, rowIndex: row, columnIndex: cells[i]!.col },
        rows: [{ values: cells.slice(i, j + 1).map((c) => cellData(c.value)) }],
        fields: "userEnteredValue",
      } });
      i = j + 1;
    }
  }
}

// ── Telemetry ───────────────────────────────────────────────────────────────

async function openRun(dryRun: boolean, startedBy: string): Promise<string> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO sync_run (kind, mode, status, date_from, date_to, full_backfill, started_by)
       VALUES ('sheet_push', $1, 'running', current_date, current_date, false, $2) RETURNING id`,
      [dryRun ? "dry_run" : "commit", startedBy]);
    return rows[0]!.id;
  }, "sheet-push:open-run", { quiet: true });
}

async function closeRun(id: string, status: "completed" | "failed", counts: Record<string, unknown>, errorMessage?: string): Promise<void> {
  await withServiceRole(async (c) => {
    await c.query(`UPDATE sync_run SET status = $2, finished_at = now(), counts = $3::jsonb, error_message = $4 WHERE id = $1`,
      [id, status, JSON.stringify(counts), errorMessage ?? null]);
  }, "sheet-push:close-run", { quiet: true });
}

/** The latest push, for the page's status line. */
export async function lastSheetPush(): Promise<{ startedAt: string; finishedAt: string | null; status: string; mode: string; counts: Record<string, unknown> | null; errorMessage: string | null } | null> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ started_at: Date; finished_at: Date | null; status: string; mode: string; counts: Record<string, unknown> | null; error_message: string | null }>(
      `SELECT started_at, finished_at, status, mode, counts, error_message FROM sync_run WHERE kind = 'sheet_push' ORDER BY started_at DESC LIMIT 1`);
    const r = rows[0];
    return r ? { startedAt: r.started_at.toISOString(), finishedAt: r.finished_at ? r.finished_at.toISOString() : null, status: r.status, mode: r.mode, counts: r.counts, errorMessage: r.error_message } : null;
  }, "sheet-push:last", { quiet: true });
}
