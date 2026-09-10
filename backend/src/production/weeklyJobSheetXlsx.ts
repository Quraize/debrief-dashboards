/**
 * The Weekly Job Sheet as an Excel workbook that reproduces the master
 * sheet's WEEKLY JOB SHEET tab row for row (shared/src/weeklyJobSheetMaster.js
 * is the column map read off the office's copy):
 *
 *   row 1     the tab's headers, every column A..BS and HT..HZ, in the tab's
 *             colours, widths and hidden state;
 *   row 2     the week label ("9/7/2026-9/13/2026") when a week was asked for;
 *   then      one job per row — synced columns filled from JobProgress, the
 *             tab's own formulas in T, AA and AB, checkboxes unticked, dates
 *             and money as real Excel values, dropdowns on the hand-filled
 *             columns — and the tab's "Weekly Total" row.
 *
 * A second sheet carries the schedule and payment detail behind the row, and
 * an About sheet says where everything came from.
 */
import ExcelJS from "exceljs";
import {
  MASTER_COLUMNS, MASTER_SYNCED, MASTER_MANUAL, FILLS, NUM_FMT, columnFormula, weekLabel,
} from "@allied/shared/weeklyJobSheetMaster";
import { sheetDate } from "@allied/shared/weeklyJobSheet";
import type { SheetRow, WeekFilter } from "./weeklyJobSheet.js";

type Column = {
  col: string; header: string; key?: string; type: string; width: number; fill: string | null;
  hidden?: boolean; list?: string[]; formula?: string;
};

const FONT: Partial<ExcelJS.Font> = { name: "Arial", size: 8, bold: true };
const THIN: Partial<ExcelJS.Border> = { style: "thin", color: { argb: "FF999999" } };
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const solid = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
/** The money columns the tab's Weekly Total row sums. */
const TOTALLED = new Set(["R", "S", "T", "Y", "Z", "AA", "AB"]);

/** `YYYY-MM-DD` → a date-only Excel value (noon UTC keeps the day stable in any zone). */
const excelDate = (iso: string): Date => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

export interface WorkbookMeta { filter: WeekFilter; generatedAt: string; syncedAt: string | null; total: number }

function cellValue(column: Column, row: SheetRow, meta: WorkbookMeta): ExcelJS.CellValue {
  if (column.type === "check") return column.key ? Boolean((row as unknown as Record<string, unknown>)[column.key]) : false;
  if (!column.key) return null;
  if (column.key === "syncedAt") return meta.syncedAt ? new Date(meta.syncedAt) : null;
  if (column.key === "syncStatus") return "Synced from JobProgress API";
  const v = (row as unknown as Record<string, unknown>)[column.key];
  if (v === null || v === undefined || v === "") return null;
  if (column.type === "date") return excelDate(String(v));
  if (column.type === "datetime") return new Date(String(v));
  if (column.type === "money" || column.type === "pct") return Number(v);
  return String(v);
}

function styleCell(cell: ExcelJS.Cell, column: Column): void {
  cell.font = FONT;
  cell.border = BORDER;
  cell.alignment = column.type === "check" || column.type === "date"
    ? { horizontal: "center", vertical: "middle" }
    : column.type === "money" || column.type === "pct"
      ? { horizontal: "right", vertical: "middle" }
      : { horizontal: "left", vertical: "middle", wrapText: true };
  const fmt = (NUM_FMT as Record<string, string>)[column.type];
  if (fmt) cell.numFmt = fmt;
  if (column.list) {
    cell.dataValidation = { type: "list", allowBlank: true, formulae: [`"${column.list.join(",")}"`] };
  }
}

export async function buildWeeklySheetWorkbook(rows: SheetRow[], meta: WorkbookMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Allied Sales Sync";
  wb.created = new Date(meta.generatedAt);
  const columns = MASTER_COLUMNS as Column[];

  // ── The tab ──
  const ws = wb.addWorksheet("WEEKLY JOB SHEET", { views: [{ state: "frozen", xSplit: 1, ySplit: 1, topLeftCell: "B2" }] });
  for (const c of columns) {
    const col = ws.getColumn(c.col);
    col.width = c.width;
    if (c.hidden) col.hidden = true;
    const h = ws.getCell(`${c.col}1`);
    h.value = c.header;
    h.font = { ...FONT, color: { argb: c.fill === "ledger" || c.fill === "navy" ? "FFFFFFFF" : "FF000000" } };
    if (c.fill) h.fill = solid((FILLS as Record<string, string>)[c.fill]!);
    h.alignment = { horizontal: "center", vertical: "bottom", wrapText: true };
    h.border = BORDER;
  }
  ws.getRow(1).height = 30;

  let r = 2;
  const label = weekLabel(meta.filter.from ?? null, meta.filter.to ?? null);
  if (label) {
    const cell = ws.getCell(`A${r}`);
    cell.value = label;
    cell.font = { ...FONT, color: { argb: "FF34A853" } };
    cell.fill = solid("FFFFFF00");
    cell.alignment = { horizontal: "left", vertical: "middle" };
    cell.border = BORDER;
    r++;
  }

  const firstJobRow = r;
  for (const row of rows) {
    for (const c of columns) {
      const cell = ws.getCell(`${c.col}${r}`);
      const formula = columnFormula(c, r);
      if (formula) {
        // Cached result only where the feed knows it; Excel computes the rest on open.
        const cached = c.key ? (row as unknown as Record<string, unknown>)[c.key] : undefined;
        cell.value = { formula, result: cached == null ? undefined : Number(cached) } as ExcelJS.CellFormulaValue;
      } else {
        cell.value = cellValue(c, row, meta);
      }
      styleCell(cell, c);
      if (c.key === "label") cell.font = { ...FONT, color: { argb: "FF0000FF" } };
      if (c.key === "jpUrl" && typeof cell.value === "string") {
        cell.value = { text: "Open in JobProgress", hyperlink: cell.value };
        cell.font = { ...FONT, color: { argb: "FF1D4ED8" }, underline: true };
      }
    }
    r++;
  }
  const lastJobRow = r - 1;

  // The tab's "Weekly Total" row: sums over the money columns of the block.
  const totalCell = ws.getCell(`A${r}`);
  totalCell.value = "Weekly Total";
  for (const c of columns) {
    const cell = ws.getCell(`${c.col}${r}`);
    cell.font = FONT;
    cell.fill = solid("FFD1F1DA");
    cell.border = BORDER;
    if (TOTALLED.has(c.col)) {
      const sum = rows.reduce((n, row) => n + Number((row as unknown as Record<string, unknown>)[c.key ?? ""] ?? 0), 0);
      cell.value = rows.length
        ? ({ formula: `SUM(${c.col}${firstJobRow}:${c.col}${lastJobRow})`, result: Math.round(sum * 100) / 100 } as ExcelJS.CellFormulaValue)
        : 0;
      cell.numFmt = NUM_FMT.money;
      cell.alignment = { horizontal: "right", vertical: "middle" };
    }
  }

  // ── Detail behind the row ──
  const detail = wb.addWorksheet("JP DETAIL");
  detail.columns = [
    { header: "Town/Address/Customer", key: "label", width: 40 },
    { header: "Job #", key: "jobNumber", width: 16 },
    { header: "JP Job ID", key: "jobId", width: 11 },
    { header: "Stage", key: "stage", width: 26 },
    { header: "Stage since", key: "stageSince", width: 12 },
    { header: "First install", key: "scheduledInstallDate", width: 12 },
    { header: "Next install", key: "nextInstallDate", width: 12 },
    { header: "All install days", key: "installDays", width: 40 },
    { header: "Payments on job", key: "paymentsCount", width: 10 },
    { header: "Vendor bills (vendor · category · amount · date)", key: "billsText", width: 70 },
    { header: "Money as of", key: "financialsFetchedAt", width: 18 },
    { header: "Payments as of", key: "paymentsFetchedAt", width: 18 },
    { header: "Bills as of", key: "billsFetchedAt", width: 18 },
  ];
  detail.getRow(1).font = { bold: true };
  for (const row of rows) {
    detail.addRow({
      label: row.label, jobNumber: row.jobNumber, jobId: row.jobId, stage: row.stage,
      stageSince: row.stageSince ? sheetDate(officeDay(row.stageSince)) : "",
      scheduledInstallDate: row.scheduledInstallDate ? sheetDate(row.scheduledInstallDate) : "",
      nextInstallDate: row.nextInstallDate ? sheetDate(row.nextInstallDate) : "",
      installDays: row.installDates.map(sheetDate).join(", "),
      paymentsCount: row.paymentsCount,
      billsText: row.bills.map((b) => `${b.vendorName ?? "?"} · ${b.category} · $${Number(b.amount).toFixed(2)}${b.date ? ` · ${sheetDate(b.date)}` : ""}`).join("\n"),
      financialsFetchedAt: row.financialsFetchedAt ? new Date(row.financialsFetchedAt) : null,
      paymentsFetchedAt: row.paymentsFetchedAt ? new Date(row.paymentsFetchedAt) : null,
      billsFetchedAt: row.billsFetchedAt ? new Date(row.billsFetchedAt) : null,
    });
  }
  detail.getColumn("billsText").alignment = { wrapText: true, vertical: "top" };
  detail.getColumn("financialsFetchedAt").numFmt = NUM_FMT.datetime;
  detail.getColumn("paymentsFetchedAt").numFmt = NUM_FMT.datetime;
  detail.getColumn("billsFetchedAt").numFmt = NUM_FMT.datetime;

  // ── Provenance ──
  const about = wb.addWorksheet("About");
  about.columns = [{ width: 30 }, { width: 100 }];
  const basisLabel: Record<string, string> = {
    install: "a production visit is scheduled inside the week",
    sale: "the contract was signed inside the week",
    stage: "the job's stage changed inside the week",
    any: "any of: visit scheduled, sold, or stage changed inside the week",
  };
  const et = (iso: string) => new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";
  const lines: [string, string][] = [
    ["Source", "JobProgress, via the Allied Sales Sync mirror (jobs in Project Won, Production and Warranty stages)"],
    ["Generated", et(meta.generatedAt)],
    ["JobProgress last synced", meta.syncedAt ? et(meta.syncedAt) : "unknown"],
    ["Week", label || "all tracked jobs (no week filter)"],
    ["Week rule", label ? basisLabel[meta.filter.basis ?? "install"] ?? "" : "n/a"],
    ["Rows", `${rows.length} of ${meta.total} tracked jobs`],
    ["", ""],
    ["Layout", "The WEEKLY JOB SHEET tab's own columns, letters and colours; hidden columns are hidden as on the tab (I, J, V–X, AU, HT–HZ)."],
    ["Filled from JobProgress", MASTER_SYNCED.map((c) => `${c.col} ${c.header}`).join(", ")],
    ["Filled by the team", MASTER_MANUAL.map((c) => `${c.col} ${c.header}`).join(", ")],
    ["Checkboxes", "Unticked (FALSE). In Google Sheets, select the column and Insert → Checkbox to show them as boxes."],
    ["Formulas", "T = R + S, AA = Y + Z, AB = T − AA, Weekly Total = SUM of the block — the tab's own; they recalculate when a cell is edited."],
    ["A Town/Address/Customer", "built from the JobProgress job address and customer name"],
    ["O Sub", "sub-contractors on the job; if none, the crews on its production schedules"],
    ["P Scheduled Install Date", "the job's first production schedule; every scheduled day is on the JP DETAIL sheet"],
    ["R, S, T", "JobProgress financial summary: job price, change orders, total revenue"],
    ["U, Y, Z", "the job's payment history: methods used; first payment; every later payment summed. Canceled payments ignored."],
    ["AA, AB", "JobProgress: payments received, amount owed"],
    ["AC Job #", "the JobProgress job number (the tab had SQs here)"],
    ["AD Material Vendor", "material suppliers that have billed the job in JobProgress (vendor bills), in the tab's short names — so it fills after delivery, not at ordering"],
    ["AI Container Scheduled", "ticked when a carting company (e.g. Bin Drop Waste Services) has billed the job"],
    ["AJ Sub Scheduled", "ticked when a live production schedule on the job has a crew assigned"],
    ["BH, BI, BJ, BL", "actual costs from the job's vendor bills, by vendor: material suppliers, subs, carting, other. BK Dealer Fee stays by hand."],
    ["BM–BS", "the tab's arithmetic as formulas: COGS = BH..BL, GP $ = T − COGS, and each cost as a share of T"],
  ];
  for (const l of lines) about.addRow(l);
  about.getColumn(1).font = { bold: true };
  about.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

const officeDay = (iso: string): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
