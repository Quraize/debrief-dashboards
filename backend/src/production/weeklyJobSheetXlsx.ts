/**
 * The Weekly Job Sheet as an Excel workbook, laid out like the master sheet's
 * WEEKLY JOB SHEET tab: row 1 holds the tab's headers in columns A..AB, one
 * job per row beneath, a Weekly Total row like the tab's own, then the
 * JobProgress link columns. Money and dates are real Excel numbers/dates
 * with the tab's formats, so the block can be copied over the tab as-is.
 *
 * Values are what JobProgress reports; the tab's formula columns (T, AA, AB)
 * are written as values too, so a manager comparing sees the CRM's figures.
 */
import ExcelJS from "exceljs";
import { SHEET_COLUMNS, LINK_COLUMNS, AUTOMATED_COLUMNS, sheetDate } from "@allied/shared/weeklyJobSheet";
import type { SheetRow, WeekFilter } from "./weeklyJobSheet.js";

const MONEY_FMT = '"$"#,##0.00';
const DATE_FMT = "m/d/yyyy";
const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
const TOTAL_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };

type Column = { col: string; header: string; key?: string; type?: string; pending?: boolean };

/** `YYYY-MM-DD` → a date-only Excel value (noon UTC keeps the day stable in any zone). */
const excelDate = (iso: string): Date => new Date(`${iso.slice(0, 10)}T12:00:00Z`);

function cellValue(column: Column, row: SheetRow): ExcelJS.CellValue {
  if (!column.key) return null;
  const v = (row as unknown as Record<string, unknown>)[column.key];
  if (v === null || v === undefined || v === "") return null;
  if (Array.isArray(v)) return v.length ? v.map((d) => (column.type === "date" ? sheetDate(String(d)) : String(d))).join(", ") : null;
  if (column.type === "date") return excelDate(String(v));
  if (column.type === "datetime") return new Date(String(v));
  if (column.type === "money") return Number(v);
  return String(v);
}

export interface WorkbookMeta { filter: WeekFilter; generatedAt: string; syncedAt: string | null; total: number }

export async function buildWeeklySheetWorkbook(rows: SheetRow[], meta: WorkbookMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Allied Sales Sync";
  wb.created = new Date(meta.generatedAt);

  const ws = wb.addWorksheet("WEEKLY JOB SHEET", { views: [{ state: "frozen", ySplit: 1, xSplit: 1 }] });
  // After AB: the link columns, then the schedule detail behind column P.
  const extra: Column[] = [
    ...LINK_COLUMNS,
    { header: "Next Install", key: "nextInstallDate", type: "date" },
    { header: "Install Days", key: "installDates", type: "date" },
  ].map((c, i) => ({ ...c, col: `X${i + 1}` }));
  const columns: Column[] = [...SHEET_COLUMNS, ...extra];

  ws.columns = columns.map((c) => ({
    header: c.header,
    key: c.col,
    width: c.type === "money" ? 14 : c.type === "date" ? 12 : c.key === "jobNumber" ? 18 : c.key ? 22 : 10,
  }));
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: "middle", wrapText: true };
  header.height = 30;

  for (const r of rows) {
    const excelRow = ws.addRow(columns.map((c) => cellValue(c, r)));
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      if (c.type === "money") cell.numFmt = MONEY_FMT;
      else if (c.type === "date" && cell.value instanceof Date) cell.numFmt = DATE_FMT;
      else if (c.type === "datetime") cell.numFmt = "m/d/yyyy h:mm";
      if (c.key === "jpUrl" && typeof cell.value === "string") {
        cell.value = { text: "Open in JobProgress", hyperlink: cell.value };
        cell.font = { color: { argb: "FF1D4ED8" }, underline: true };
      }
    });
  }

  // The tab's own "Weekly Total" row: sums over the money columns.
  const first = 2;
  const last = ws.rowCount;
  const total = ws.addRow([]);
  total.getCell(1).value = "Weekly Total";
  total.font = { bold: true };
  total.fill = TOTAL_FILL;
  columns.forEach((c, i) => {
    if (c.type !== "money") return;
    const letter = ws.getColumn(i + 1).letter;
    const cell = total.getCell(i + 1);
    cell.value = rows.length ? { formula: `SUM(${letter}${first}:${letter}${last})`, result: rows.reduce((n, r) => n + Number((r as unknown as Record<string, unknown>)[c.key!] ?? 0), 0) } : 0;
    cell.numFmt = MONEY_FMT;
  });

  // Provenance, so the file explains itself when it is forwarded.
  const about = wb.addWorksheet("About");
  about.columns = [{ width: 28 }, { width: 90 }];
  const basisLabel: Record<string, string> = {
    install: "a production visit is scheduled inside the week",
    sale: "the contract was signed inside the week",
    stage: "the job's stage changed inside the week",
    any: "any of: visit scheduled, sold, or stage changed inside the week",
  };
  const lines: [string, string][] = [
    ["Source", "JobProgress, via the Allied Sales Sync mirror (jobs in Project Won, Production and Warranty stages)"],
    ["Generated", new Date(meta.generatedAt).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET"],
    ["JobProgress last synced", meta.syncedAt ? new Date(meta.syncedAt).toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET" : "unknown"],
    ["Week", meta.filter.from || meta.filter.to ? `${meta.filter.from ?? "…"} to ${meta.filter.to ?? "…"}` : "all tracked jobs (no week filter)"],
    ["Week rule", meta.filter.from || meta.filter.to ? basisLabel[meta.filter.basis ?? "install"] ?? "" : "n/a"],
    ["Rows", `${rows.length} of ${meta.total} tracked jobs`],
    ["", ""],
    ["Filled from JobProgress", AUTOMATED_COLUMNS.map((c) => `${c.col} ${c.header}`).join(", ")],
    ["Scheduled Install Date (P)", "the job's first production schedule; every scheduled day is listed in the Install Days column"],
    ["Sub (O)", "sub-contractors on the job; if none, the crews on its production schedules"],
    ["Gross / Change Orders / Total (R, S, T)", "JobProgress financial summary: job price, change orders, total revenue"],
    ["Payment Method / Deposit / Progress (U, Y, Z)", "the job's payment history: methods used; first payment; every later payment summed. Canceled payments ignored."],
    ["Total Payments / Balance Owed (AA, AB)", "JobProgress financial summary: payments received, amount owed"],
    ["Still by hand", "B–J checkboxes, Lender (V–X), SQs (AC), Material Vendor (AD)"],
  ];
  for (const l of lines) about.addRow(l);
  about.getColumn(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
