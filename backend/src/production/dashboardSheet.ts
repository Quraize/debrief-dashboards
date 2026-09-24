/**
 * [AUTOMATION] Production KPIs DASHBOARD — a friendly tab of cards and charts
 * that reads the automated weekly job sheet, with a Month and a Week filter.
 *
 * Two tabs:
 *
 *   DATA  "[AUTOMATION] Dashboard Data", rewritten on every push. One row per
 *         job per week block exactly as the weekly tab holds them (stale rows
 *         out), with the money columns; every payment with its date; the list
 *         of weeks and months; the overdue balance as of today. Values only,
 *         except the week-choice list and the chart table, which are formulas
 *         that follow the dashboard's Month cell.
 *
 *   DASHBOARD  "[AUTOMATION] Production KPIs DASHBOARD", laid out ONCE, the
 *         first time the automation finds it missing: title, Month and Week
 *         dropdowns, number cards, three charts. Every number is a live
 *         formula over the data tab. It is never overwritten afterwards, and
 *         it is not locked — anyone reviewing can edit it.
 *
 * A job whose install spans two weeks of one month sits in both week blocks;
 * the data tab marks its first live row in each month (CountInMonth = 1) and
 * the month view sums only those, so a month never counts a job twice.
 */
import { withServiceRole } from "../db/client.js";
import { a1, type GoogleSheetsClient, type CellValue } from "../integrations/google/sheets.js";
import type { SheetRow } from "./weeklyJobSheet.js";
import { parseBlocks } from "./sheetPlan.js";
import { weekLabel } from "@allied/shared/weeklyJobSheetMaster";
import { isInstallCode } from "@allied/shared/production";
import { revenueRow, AR_OVERDUE_DAYS_DEFAULT } from "@allied/shared/revenueAr";

export const DASHBOARD_TAB_DEFAULT = "[AUTOMATION] Production KPIs DASHBOARD";
export const DATA_TAB_DEFAULT = "[AUTOMATION] Dashboard Data";
export const ALL_WEEKS = "All weeks";
export const OVERDUE_LABEL = "Overdue: finished jobs still unpaid 30+ days (today, ignores filters)";
/**
 * Card headings renamed after the dashboard was first laid out. The tab is
 * never overwritten, so each push rewrites a heading ONLY while it still
 * reads the old text — a heading someone has retitled is left alone.
 */
export const LABEL_RENAMES: { cell: string; row: number; col: number; from: string; to: string }[] = [
  { cell: "E9", row: 8, col: 4, from: "Overdue Balance (today, 30+ days)", to: OVERDUE_LABEL },
];
const STALE = "Not on the JobProgress calendar this week";

export interface PaymentRow { date: string; amount: number; method: string | null; jobId: string; jobNumber: string | null; customer: string | null }

const COL = (letter: string) => letter.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const cellStr = (v: CellValue | undefined) => (v === null || v === undefined ? "" : String(v).trim());
const serial = (iso: string) => Math.round((Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
export const monthLabel = (iso: string) => new Date(`${iso.slice(0, 7)}-01T12:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const monthBounds = (iso: string) => {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return { from: `${iso.slice(0, 7)}-01`, to: new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10) };
};
const num = (v: unknown) => { const n = Number(v); return v === null || v === undefined || v === "" || !Number.isFinite(n) ? 0 : n; };

// ── Data tab ────────────────────────────────────────────────────────────────

export interface DashboardData {
  jobs: CellValue[][]; payments: CellValue[][]; weeks: CellValue[][]; months: CellValue[][];
  overdue: number; counts: { jobRows: number; payments: number; weeks: number };
}

/**
 * Everything the data tab holds, from the weekly tab as the push left it
 * (`grid`), the feed's money for each job, and the payments.
 */
export function dashboardData(grid: CellValue[][], feedRows: SheetRow[], payments: PaymentRow[], today: string, overdueDays = AR_OVERDUE_DAYS_DEFAULT): DashboardData {
  const HU = COL("HU"), HY = COL("HY");
  const byId = new Map(feedRows.map((r) => [r.jobId, r]));
  const blocks = parseBlocks(grid).sort((a, b) => a.from.localeCompare(b.from));
  const jobs: CellValue[][] = [];
  const seenInMonth = new Map<string, Set<string>>();
  for (const b of blocks) {
    const month = monthLabel(b.from);
    const seen = seenInMonth.get(month) ?? seenInMonth.set(month, new Set()).get(month)!;
    for (const idx of b.jobIdx) {
      const id = cellStr(grid[idx]?.[HU]);
      if (!id || cellStr(grid[idx]?.[HY]) === STALE) continue;       // stale rows are out of every total, here as on the tab
      const r = byId.get(id);
      if (!r) continue;
      const first = !seen.has(id); seen.add(id);
      const pif = String(r.pifStatus ?? "").toUpperCase().startsWith("YES") ? "YES" : r.pifStatus ? "NO" : "";
      jobs.push([serial(b.from), serial(b.to), weekLabel(b.from, b.to), month, id, r.jobNumber, r.customer ?? r.label,
        num(r.gross), num(r.totalRev), num(r.deposit), num(r.progressPayments), num(r.totalPayments), Math.max(0, num(r.balanceOwed)), pif, first ? 1 : 0]);
    }
  }
  const weeks: CellValue[][] = [...blocks].reverse().map((b) => [weekLabel(b.from, b.to), serial(b.from), serial(b.to), monthLabel(b.from)]);
  const pays = [...payments].sort((a, b) => b.date.localeCompare(a.date));
  const monthSet = new Map<string, string>();
  for (const b of blocks) monthSet.set(monthLabel(b.from), b.from.slice(0, 7));
  for (const p of pays) monthSet.set(monthLabel(p.date), p.date.slice(0, 7));
  monthSet.set(monthLabel(today), today.slice(0, 7));
  const months: CellValue[][] = [...monthSet.entries()].sort((a, b) => b[1].localeCompare(a[1]))
    .map(([label, ym]) => { const mb = monthBounds(`${ym}-01`); return [label, serial(mb.from), serial(mb.to)]; });
  // Overdue as of today, over every job the feed knows — the same rule as the Revenue & AR page.
  let overdue = 0;
  for (const r of feedRows) {
    const row = revenueRow({
      jobId: r.jobId, contractSignedDate: r.saleDate, stage: r.stage, contract: r.totalRev, received: r.totalPayments, owed: r.balanceOwed,
      completionDate: r.completionDate, installDays: [...new Set((r.visits ?? []).filter((v) => isInstallCode(v.code)).map((v) => v.day))].sort(), payments: [],
    }, today, { overdueDays });
    if (row?.overdue) overdue += num(row.owed);
  }
  return {
    jobs, weeks, months, overdue: Math.round(overdue * 100) / 100,
    payments: pays.map((p) => [serial(p.date), monthLabel(p.date), p.jobId, p.customer, p.amount, p.method]),
    counts: { jobRows: jobs.length, payments: pays.length, weeks: weeks.length },
  };
}

/** Every live payment since `since`, with its job — the source of "Collected in period". */
export async function loadPayments(since: string): Promise<PaymentRow[]> {
  return withServiceRole(async (c) => {
    const { rows } = await c.query<{ payment_date: string; amount: string; method: string | null; jp_job_id: string; job_number: string | null; customer_name: string | null }>(
      `SELECT p.payment_date::text, p.amount::text, coalesce(p.method_label, p.method) AS method, p.jp_job_id, j.job_number, cu.customer_name
         FROM jp_job_payment p
         JOIN jp_job j ON j.jp_job_id = p.jp_job_id
         LEFT JOIN jp_customer cu ON cu.jp_customer_id = j.jp_customer_id
        WHERE p.deleted_at IS NULL AND NOT p.canceled AND p.amount > 0
          AND coalesce(p.status, '') !~* 'cancel|void'
          AND p.payment_date IS NOT NULL AND p.payment_date >= $1::date`, [since]);
    return rows.map((r) => ({ date: r.payment_date, amount: Number(r.amount), method: r.method, jobId: r.jp_job_id, jobNumber: r.job_number, customer: r.customer_name }));
  }, "sheet-push:dashboard-payments", { quiet: true });
}

// ── Requests ────────────────────────────────────────────────────────────────

const q = (tab: string) => `'${tab.replace(/'/g, "''")}'`;
const cell = (v: CellValue | { formula: string }): Record<string, unknown> => {
  if (v === null || v === undefined || v === "") return { userEnteredValue: null };
  if (typeof v === "object") return { userEnteredValue: { formulaValue: v.formula } };
  if (typeof v === "number") return { userEnteredValue: { numberValue: v } };
  if (typeof v === "boolean") return { userEnteredValue: { boolValue: v } };
  return { userEnteredValue: { stringValue: v } };
};
const rowsAt = (sheetId: number, row: number, col: number, values: (CellValue | { formula: string })[][]) =>
  ({ updateCells: { start: { sheetId, rowIndex: row, columnIndex: col }, rows: values.map((r) => ({ values: r.map(cell) })), fields: "userEnteredValue" } });
const fmt = (sheetId: number, r0: number, r1: number, c0: number, c1: number, format: Record<string, unknown>, fields: string) =>
  ({ repeatCell: { range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }, cell: { userEnteredFormat: format }, fields } });
const DATE = { numberFormat: { type: "DATE", pattern: "m/d/yyyy" } };
const MONEY = { numberFormat: { type: "CURRENCY", pattern: "\"$\"#,##0" } };

/** Rewrites the data tab: values in A:AF, formulas for the week choices and the chart table, the overdue snapshot. */
export function dataTabRequests(dataId: number, data: DashboardData, dashTab: string): unknown[] {
  const D = q(dashTab);
  const reqs: unknown[] = [
    // Clear the value areas (A:AF), then write them.
    { updateCells: { range: { sheetId: dataId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: COL("AF") + 1 }, fields: "userEnteredValue" } },
    rowsAt(dataId, 0, COL("A"), [["Week Start", "Week End", "Week", "Month", "JP Job ID", "Job #", "Customer", "Gross $", "Total Rev", "Deposit", "Progress Payments", "Total Received", "Balance Owed", "Paid in Full", "Count In Month"], ...data.jobs]),
    rowsAt(dataId, 0, COL("R"), [["Payment Date", "Month", "JP Job ID", "Customer", "Amount", "Method"], ...data.payments]),
    rowsAt(dataId, 0, COL("Y"), [["Week", "Start", "End", "Month"], ...data.weeks]),
    rowsAt(dataId, 0, COL("AD"), [["Month", "Start", "End"], ...data.months]),
    // The week dropdown's choices: All weeks, then the selected month's weeks.
    rowsAt(dataId, 0, COL("AH"), [["Week choices"], [{ formula: `={"${ALL_WEEKS}";IFERROR(FILTER($Y$2:$Y,$AB$2:$AB=${D}!$B$4),"")}` }]]),
    // The chart table: the selected month's weeks, revenue, money collected, balance owed.
    rowsAt(dataId, 0, COL("AJ"), [["Week", "Total Revenue", "Collected", "Balance Owed"],
      ...Array.from({ length: 7 }, (_, i) => {
        const r = i + 2, wk = `$AJ${r}`;
        return [
          { formula: `=IFERROR(INDEX(FILTER($Y$2:$Y,$AB$2:$AB=${D}!$B$4),${i + 1}),"")` },
          { formula: `=IF(${wk}="","",SUMIFS($I:$I,$C:$C,${wk}))` },
          { formula: `=IF(${wk}="","",SUMIFS($V:$V,$R:$R,">="&VLOOKUP(${wk},$Y:$AA,2,FALSE),$R:$R,"<="&VLOOKUP(${wk},$Y:$AA,3,FALSE)))` },
          { formula: `=IF(${wk}="","",SUMIFS($M:$M,$C:$C,${wk}))` },
        ];
      })]),
    rowsAt(dataId, 0, COL("AO"), [["Overdue Balance (today)"], [data.overdue]]),
    fmt(dataId, 1, 5000, COL("A"), COL("B") + 1, DATE, "userEnteredFormat.numberFormat"),
    fmt(dataId, 1, 5000, COL("R"), COL("R") + 1, DATE, "userEnteredFormat.numberFormat"),
    fmt(dataId, 1, 5000, COL("Z"), COL("AA") + 1, DATE, "userEnteredFormat.numberFormat"),
    fmt(dataId, 1, 5000, COL("AE"), COL("AF") + 1, DATE, "userEnteredFormat.numberFormat"),
    fmt(dataId, 0, 1, 0, COL("AO") + 1, { textFormat: { bold: true } }, "userEnteredFormat.textFormat"),
  ];
  return reqs;
}

/**
 * The dashboard, laid out once: title, filters, cards, charts. Every number is
 * a formula over the data tab; the Month cell starts on `today`'s month.
 */
export function dashboardLayoutRequests(dashId: number, dataId: number, dataTab: string, today: string): unknown[] {
  const DT = q(dataTab);
  const col = (L: string) => `${DT}!$${L}:$${L}`;
  const allWeeks = `$E$4="${ALL_WEEKS}"`;
  /** A job-money metric: the month (first row per job) or the one week. */
  const metric = (L: string) => ({ formula: `=IF(${allWeeks},SUMIFS(${col(L)},${col("D")},$B$4,${col("O")},1),SUMIFS(${col(L)},${col("C")},$E$4))` });
  const paidCount = (v: string) => ({ formula: `=IF(${allWeeks},COUNTIFS(${col("N")},"${v}",${col("D")},$B$4,${col("O")},1),COUNTIFS(${col("N")},"${v}",${col("C")},$E$4))` });
  const paidMoney = (v: string) => `IF(${allWeeks},SUMIFS(${col("I")},${col("N")},"${v}",${col("D")},$B$4,${col("O")},1),SUMIFS(${col("I")},${col("N")},"${v}",${col("C")},$E$4))`;
  const collected = { formula: `=IF(${allWeeks},SUMIFS(${col("V")},${col("S")},$B$4),SUMIFS(${col("V")},${col("R")},">="&VLOOKUP($E$4,${DT}!$Y:$AA,2,FALSE),${col("R")},"<="&VLOOKUP($E$4,${DT}!$Y:$AA,3,FALSE)))` };
  const LABEL = { backgroundColor: { red: 0.93, green: 0.95, blue: 0.98 }, textFormat: { bold: true, fontSize: 10, foregroundColor: { red: 0, green: 0, blue: 0 } }, horizontalAlignment: "CENTER", wrapStrategy: "WRAP" };
  const VALUE = { textFormat: { bold: true, fontSize: 16, foregroundColor: { red: 0, green: 0, blue: 0 } }, horizontalAlignment: "CENTER" };
  const src = (sheetId: number, r0: number, r1: number, c0: number) => ({ sourceRange: { sources: [{ sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c0 + 1 }] } });
  const chartTable = (c: number) => src(dataId, 0, 8, COL("AJ") + c);
  const at = (row: number, column: number, w: number, h: number) => ({ overlayPosition: { anchorCell: { sheetId: dashId, rowIndex: row, columnIndex: column }, widthPixels: w, heightPixels: h } });
  return [
    rowsAt(dashId, 0, 0, [
      ["Production KPIs Dashboard"],
      ["Reads the [AUTOMATION] weekly job sheet, refreshed every hour. Pick a month, then a week or All weeks. Collected = payments dated in the period."],
      [],
      ["Month", monthLabel(today), null, "Week", ALL_WEEKS],
      [],
      ["Gross $", "Total Revenue", "Deposits", "Progress Payments", "Total Received"],
      [metric("H"), metric("I"), metric("J"), metric("K"), metric("L")],
      [],
      ["Balance Owed", "Collected in Period", "Paid in Full (jobs)", "Not Paid in Full (jobs)", OVERDUE_LABEL],
      [metric("M"), collected, paidCount("YES"), paidCount("NO"), { formula: `=${DT}!$AO$2` }],
      [null, null, { formula: `="$"&TEXT(${paidMoney("YES")},"#,##0")&" of revenue"` }, { formula: `="$"&TEXT(${paidMoney("NO")},"#,##0")&" of revenue"` }],
    ]),
    // The pie's own two cells, beside the cards.
    rowsAt(dashId, 5, COL("H"), [["Paid in full", { formula: "=C10" }], ["Not paid in full", { formula: "=D10" }]]),
    // Dropdowns: Month from the data tab's months, Week from its week choices.
    { setDataValidation: { range: { sheetId: dashId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 1, endColumnIndex: 2 }, rule: { condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=${DT}!$AD$2:$AD$200` }] }, showCustomUi: true, strict: true } } },
    { setDataValidation: { range: { sheetId: dashId, startRowIndex: 3, endRowIndex: 4, startColumnIndex: 4, endColumnIndex: 5 }, rule: { condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: `=${DT}!$AH$2:$AH$30` }] }, showCustomUi: true, strict: true } } },
    fmt(dashId, 0, 1, 0, 5, { textFormat: { bold: true, fontSize: 18, foregroundColor: { red: 0, green: 0, blue: 0 } } }, "userEnteredFormat.textFormat"),
    fmt(dashId, 1, 2, 0, 5, { textFormat: { italic: true, fontSize: 9, foregroundColor: { red: 0, green: 0, blue: 0 } } }, "userEnteredFormat.textFormat"),
    fmt(dashId, 3, 4, 0, 5, { textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 0, green: 0, blue: 0 } }, backgroundColor: { red: 1, green: 1, blue: 0.6 } }, "userEnteredFormat(textFormat,backgroundColor)"),
    fmt(dashId, 5, 6, 0, 5, LABEL, "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)"),
    fmt(dashId, 8, 9, 0, 5, LABEL, "userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,wrapStrategy)"),
    fmt(dashId, 6, 7, 0, 5, { ...VALUE, ...MONEY }, "userEnteredFormat(textFormat,horizontalAlignment,numberFormat)"),
    fmt(dashId, 9, 10, 0, 2, { ...VALUE, ...MONEY }, "userEnteredFormat(textFormat,horizontalAlignment,numberFormat)"),
    fmt(dashId, 9, 10, 2, 4, VALUE, "userEnteredFormat(textFormat,horizontalAlignment)"),
    fmt(dashId, 9, 10, 4, 5, { ...VALUE, ...MONEY }, "userEnteredFormat(textFormat,horizontalAlignment,numberFormat)"),
    fmt(dashId, 10, 11, 0, 5, { textFormat: { fontSize: 9, foregroundColor: { red: 0, green: 0, blue: 0 } }, horizontalAlignment: "CENTER" }, "userEnteredFormat(textFormat,horizontalAlignment)"),
    { updateDimensionProperties: { range: { sheetId: dashId, dimension: "COLUMNS", startIndex: 0, endIndex: 5 }, properties: { pixelSize: 185 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashId, dimension: "ROWS", startIndex: 6, endIndex: 7 }, properties: { pixelSize: 42 }, fields: "pixelSize" } },
    { updateDimensionProperties: { range: { sheetId: dashId, dimension: "ROWS", startIndex: 9, endIndex: 10 }, properties: { pixelSize: 42 }, fields: "pixelSize" } },
    // Charts: revenue vs collected by week, balance owed by week, paid vs not.
    { addChart: { chart: { spec: { title: "Total Revenue vs Collected, by week (selected month)", basicChart: {
      chartType: "COLUMN", legendPosition: "BOTTOM_LEGEND", headerCount: 1,
      axis: [{ position: "BOTTOM_AXIS", title: "Week" }, { position: "LEFT_AXIS", title: "$" }],
      domains: [{ domain: chartTable(0) }],
      series: [{ series: chartTable(1), targetAxis: "LEFT_AXIS" }, { series: chartTable(2), targetAxis: "LEFT_AXIS" }],
    } }, position: at(12, 0, 560, 320) } } },
    { addChart: { chart: { spec: { title: "Balance Owed, by week (selected month)", basicChart: {
      chartType: "COLUMN", legendPosition: "NO_LEGEND", headerCount: 1,
      axis: [{ position: "BOTTOM_AXIS", title: "Week" }, { position: "LEFT_AXIS", title: "$" }],
      domains: [{ domain: chartTable(0) }], series: [{ series: chartTable(3), targetAxis: "LEFT_AXIS" }],
    } }, position: at(12, 3, 460, 320) } } },
    { addChart: { chart: { spec: { title: "Paid in Full vs Not (selected period)", pieChart: {
      legendPosition: "RIGHT_LEGEND", domain: src(dashId, 5, 7, COL("H")), series: src(dashId, 5, 7, COL("I")),
    } }, position: at(30, 0, 460, 280) } } },
  ];
}

/** Rewrites renamed card headings that still carry their old text. */
export function renameRequests(dashId: number, heads: CellValue[][]): unknown[] {
  return LABEL_RENAMES.filter((r) => cellStr(heads[r.row]?.[r.col]) === r.from).map((r) => rowsAt(dashId, r.row, r.col, [[r.to]]));
}

export interface DashboardPushResult { created: boolean; jobRows: number; payments: number; weeks: number; overdue: number }

/** A stable, positive sheet id for a tab we add (so the same batch can address it). */
const newSheetId = () => 100_000_000 + Math.floor(Math.random() * 1_900_000_000);

/** Ensures both tabs exist, rewrites the data tab, lays out the dashboard the first time. */
export async function pushDashboard(
  client: GoogleSheetsClient, input: { grid: CellValue[][]; feedRows: SheetRow[]; today: string; dashTab: string; dataTab: string; overdueDays: number; payments?: PaymentRow[] },
): Promise<DashboardPushResult> {
  const since = `${Number(input.today.slice(0, 4)) - 1}-01-01`;
  const payments = input.payments ?? await loadPayments(since);
  const data = dashboardData(input.grid, input.feedRows, payments, input.today, input.overdueDays);
  const reqs: unknown[] = [];
  const dash = await client.sheetByTitle(input.dashTab);
  let dataTab = await client.sheetByTitle(input.dataTab);
  const dashId = dash?.sheetId ?? newSheetId();
  const dataId = dataTab?.sheetId ?? newSheetId();
  if (!dataTab) {
    reqs.push({ addSheet: { properties: { sheetId: dataId, title: input.dataTab, gridProperties: { rowCount: 5000, columnCount: 45, frozenRowCount: 1 } } } });
    dataTab = { sheetId: dataId, rowCount: 5000, columnCount: 45 };
  } else if (dataTab.columnCount < 45) {
    reqs.push({ appendDimension: { sheetId: dataId, dimension: "COLUMNS", length: 45 - dataTab.columnCount } });
  }
  if (!dash) reqs.push({ addSheet: { properties: { sheetId: dashId, title: input.dashTab, index: 0, gridProperties: { rowCount: 60, columnCount: 12 } } } });
  reqs.push(...dataTabRequests(dataId, data, input.dashTab));
  if (!dash) reqs.push(...dashboardLayoutRequests(dashId, dataId, input.dataTab, input.today));
  else {
    const heads = await client.getValues(a1(input.dashTab, "A1:L12"));
    reqs.push(...renameRequests(dashId, heads));
  }
  await client.batchUpdate(reqs);
  return { created: !dash, jobRows: data.counts.jobRows, payments: data.counts.payments, weeks: data.counts.weeks, overdue: data.overdue };
}

