/**
 * The Google Sheet planner: pure rules for laying the feed onto the
 * [AUTOMATION] tab without touching the team's cells.
 */
import { describe, it, expect } from "vitest";
import { planSheet, parseBlocks, parseWeekLabel, colIndex, dateSerial, weekBounds, SYNC_STATUS_STALE, type CellWrite } from "../src/production/sheetPlan.js";
import { toRequests } from "../src/production/sheetPush.js";
import type { SheetRow } from "../src/production/weeklyJobSheet.js";
import { MASTER_COLUMNS } from "@allied/shared/weeklyJobSheetMaster";

const HU = colIndex("HU"), HY = colIndex("HY"), AC = colIndex("AC"), R = colIndex("R"), B = colIndex("B"), T = colIndex("T"), AB = colIndex("AB");
const SYNCED_AT = "2026-09-10T14:00:00.000Z";

const row = (jobId: string, over: Partial<SheetRow> = {}): SheetRow => ({
  jobId, customerId: "9" + jobId, jobNumber: `2609-${jobId}-01`, jobName: null, customer: `Customer ${jobId}`, address: `${jobId} Main St`, city: "Wayne",
  label: `Wayne/${jobId} Main St/Customer ${jobId}`, division: "ACR Roofing Division", trades: "ROOFING", insurance: false,
  stage: "Roof/Siding Scheduled", stageGroup: "production", stageSince: null, salesRep: "Jason Malarchak", sub: "Lucy Construction",
  scheduledInstallDate: "2026-09-09", saleDate: "2026-08-20", completionDate: null, installDates: ["2026-09-09"], nextInstallDate: null,
  visits: [{ day: "2026-09-09", code: "RR" }], gross: 10000, changeOrders: 0, totalRev: 10000, paymentMethod: "Check", deposit: 2000,
  progressPayments: null, paymentsCount: 1, totalPayments: 2000, balanceOwed: 8000, subScheduled: true, materialVendor: "NCBP",
  containerScheduled: false, actualMaterial: 3000, actualLabor: null, actualCarting: null, actualOther: null, billsCount: 1, bills: [],
  financialsFetchedAt: SYNCED_AT, paymentsFetchedAt: null, billsFetchedAt: null, jpUrl: `https://app.jobprogress.com/#/customer-jobs/9${jobId}/job/${jobId}/overview`,
  ...over,
});
const headerRow = () => { const h: (string | null)[] = []; for (const c of MASTER_COLUMNS) h[colIndex(c.col)] = c.header; return h; };
const cellsOf = (plan: ReturnType<typeof planSheet>) => plan.ops.flatMap((o) => (o.type === "write" ? o.cells : []));
const at = (cells: CellWrite[], r: number, c: number) => cells.find((x) => x.row === r && x.col === c)?.value;

describe("grid parsing", () => {
  it("reads the tab's week labels and blocks", () => {
    expect(parseWeekLabel("9/7/2026-9/13/2026")).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(parseWeekLabel("3/30/2026- 4/5/2026")).toEqual({ from: "2026-03-30", to: "2026-04-05" });
    expect(parseWeekLabel("Weekly Total")).toBeNull();
    const grid = [headerRow(), ["9/14/2026-9/20/2026"], ["job a"], ["Weekly Total"], [], ["9/7/2026-9/13/2026"], ["job b"], ["job c"], ["Weekly Total"]];
    expect(parseBlocks(grid)).toEqual([
      { labelIdx: 1, from: "2026-09-14", to: "2026-09-20", jobIdx: [2], totalIdx: 3 },
      { labelIdx: 5, from: "2026-09-07", to: "2026-09-13", jobIdx: [6, 7], totalIdx: 8 },
    ]);
  });
  it("knows its letters, dates and weeks", () => {
    expect(colIndex("A")).toBe(0); expect(colIndex("AC")).toBe(28); expect(colIndex("HU")).toBe(228);
    expect(dateSerial("2026-09-03")).toBe(46268);
    expect(weekBounds("2026-09-10")).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(weekBounds("2026-09-13", 1)).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    expect(weekBounds("2026-09-07", -1)).toEqual({ from: "2026-08-31", to: "2026-09-06" });
  });
});

describe("planSheet on an empty tab", () => {
  it("writes the header and one block per week, newest first, with formulas and unticked checkboxes", () => {
    const plan = planSheet([], [
      { from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2")] },
      { from: "2026-09-14", to: "2026-09-20", rows: [row("3")] },
    ], { syncedAt: SYNCED_AT });
    expect(plan.summary).toMatchObject({ headerCreated: true, blocksCreated: ["9/14/2026-9/20/2026", "9/7/2026-9/13/2026"], jobsAdded: 3, jobsUpdated: 0 });
    const cells = cellsOf(plan);
    expect(at(cells, 0, 0)).toBe("Town/Address/Customer");
    expect(at(cells, 0, AC)).toBe("Job #");
    // Row 1: newest week label; rows 2: job 3; row 3: total; row 4 spacer; row 5: older week label.
    expect(at(cells, 1, 0)).toBe("9/14/2026-9/20/2026");
    expect(at(cells, 2, 0)).toBe("Wayne/3 Main St/Customer 3");
    expect(at(cells, 2, HU)).toBe("3");
    expect(at(cells, 2, R)).toBe(10000);
    expect(at(cells, 2, B)).toBe(false);
    expect(at(cells, 2, T)).toEqual({ formula: "R3+S3" });
    expect(at(cells, 3, 0)).toBe("Weekly Total");
    expect(at(cells, 3, R)).toEqual({ formula: "SUM(R3:R3)" });
    expect(at(cells, 5, 0)).toBe("9/7/2026-9/13/2026");
    expect(at(cells, 6, HU)).toBe("1");
    expect(at(cells, 7, HU)).toBe("2");
    expect(at(cells, 8, AB)).toEqual({ formula: "SUM(AB7:AB8)" });
    const inserts = plan.ops.filter((o) => o.type === "insertRows");
    expect(inserts).toEqual([{ type: "insertRows", at: 1, count: 4 }, { type: "insertRows", at: 5, count: 5 }]);
  });
});

describe("planSheet on a tab the team has been working in", () => {
  const grid = () => {
    const g: (string | number | boolean | null)[][] = [headerRow()];
    g.push(["9/7/2026-9/13/2026"]);
    const j1: (string | number | boolean | null)[] = []; j1[0] = "Wayne/1 Main St/Customer 1"; j1[B] = true; j1[HU] = 1; j1[R] = 9999; j1[colIndex("BG")] = "call before 8";
    g.push(j1);
    const gone: (string | number | boolean | null)[] = []; gone[0] = "Old Tappan/84 Willow/Denike"; gone[HU] = "77";
    g.push(gone);
    const tot: (string | number | boolean | null)[] = []; tot[0] = "Weekly Total"; tot[R] = 9999;
    g.push(tot);
    return g;
  };
  it("updates only the synced cells of a known row, adds the new job before the total, and stamps the job the feed dropped", () => {
    const plan = planSheet(grid(), [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2")] }], { syncedAt: SYNCED_AT });
    expect(plan.summary).toMatchObject({ headerCreated: false, blocksCreated: [], jobsAdded: 1, jobsUpdated: 1, jobsNotThisWeek: 1 });
    const cells = cellsOf(plan);
    // Existing job 1 at row 2: money refreshed, the ticked PIF checkbox and the note untouched.
    expect(at(cells, 2, R)).toBe(10000);
    expect(cells.some((c) => c.row === 2 && c.col === B)).toBe(false);
    expect(cells.some((c) => c.row === 2 && c.col === colIndex("BG"))).toBe(false);
    expect(cells.some((c) => c.row === 2 && c.col === T)).toBe(false); // formulas are not rewritten on existing rows
    // New job 2 inserted before the total (which was row 4) → row 4; total moves to row 5 and re-sums 2..4.
    expect(plan.ops.filter((o) => o.type === "insertRows")).toEqual([{ type: "insertRows", at: 4, count: 1 }]);
    expect(at(cells, 4, HU)).toBe("2");
    expect(at(cells, 4, B)).toBe(false);
    expect(at(cells, 5, R)).toEqual({ formula: "SUM(R3:R5)" });
    // Denike (row 3) is not in the feed's week: stamped, kept.
    expect(at(cells, 3, HY)).toBe(SYNC_STATUS_STALE);
    expect(plan.summary.weeks[0]).toMatchObject({ existing: true, added: ["Wayne/2 Main St/Customer 2"], updated: ["Wayne/1 Main St/Customer 1"], notThisWeek: ["Old Tappan/84 Willow/Denike"] });
  });
  it("puts a missing older week after the existing block and a newer one before it", () => {
    const older = planSheet(grid(), [{ from: "2026-08-31", to: "2026-09-06", rows: [row("5")] }], { syncedAt: SYNCED_AT });
    expect(older.ops.filter((o) => o.type === "insertRows")).toEqual([{ type: "insertRows", at: 6, count: 4 }]);
    const newer = planSheet(grid(), [{ from: "2026-09-14", to: "2026-09-20", rows: [row("6")] }], { syncedAt: SYNCED_AT });
    expect(newer.ops.filter((o) => o.type === "insertRows")).toEqual([{ type: "insertRows", at: 1, count: 4 }]);
    expect(at(cellsOf(newer), 1, 0)).toBe("9/14/2026-9/20/2026");
  });
  it("is idempotent: a second pass over its own output changes nothing structural", () => {
    const first = planSheet([], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { syncedAt: SYNCED_AT });
    // Materialise the first plan into a grid.
    const g: (string | number | boolean | null)[][] = [];
    for (const op of first.ops) {
      if (op.type === "insertRows") g.splice(op.at, 0, ...Array.from({ length: op.count }, () => [] as (string | number | boolean | null)[]));
      if (op.type === "write") for (const c of op.cells) { (g[c.row] ??= [])[c.col] = typeof c.value === "object" && c.value ? `=${c.value.formula}` : c.value; }
    }
    const second = planSheet(g, [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { syncedAt: SYNCED_AT });
    expect(second.ops.filter((o) => o.type === "insertRows")).toEqual([]);
    expect(second.summary).toMatchObject({ headerCreated: false, blocksCreated: [], jobsAdded: 0, jobsUpdated: 1, jobsNotThisWeek: 0 });
  });
});

describe("toRequests", () => {
  it("turns the plan into ordered Sheets requests, writing only adjacent runs of cells", () => {
    const plan = planSheet([headerRow(), ["9/7/2026-9/13/2026"], ["Weekly Total"]], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { syncedAt: SYNCED_AT });
    const reqs = toRequests(plan, 42) as Record<string, Record<string, unknown>>[];
    expect(reqs[0]).toHaveProperty("insertDimension");
    expect((reqs[0]!["insertDimension"] as Record<string, unknown>)["range"]).toEqual({ sheetId: 42, dimension: "ROWS", startIndex: 2, endIndex: 3 });
    const updates = reqs.filter((r) => r["updateCells"]);
    expect(updates.length).toBeGreaterThan(3);
    for (const u of updates) expect((u["updateCells"] as Record<string, unknown>)["fields"]).toBe("userEnteredValue");
    // On the new row, C (PIF Date, hand-filled) is skipped, so B stands alone and one run covers
    // D..U: seven checkboxes, then the synced job columns through Payment Method (18 cells).
    const runAt = (col: number) => updates.find((u) => (u["updateCells"] as { start: { columnIndex: number; rowIndex: number } }).start.columnIndex === col && (u["updateCells"] as { start: { rowIndex: number } }).start.rowIndex === 2);
    const du = runAt(colIndex("D"))!;
    const vals = (du["updateCells"] as { rows: { values: { userEnteredValue: unknown }[] }[] }).rows[0]!.values;
    expect(vals).toHaveLength(colIndex("U") - colIndex("D") + 1);
    expect(vals[0]).toEqual({ userEnteredValue: { boolValue: false } });
    expect(vals[colIndex("K") - colIndex("D")]).toEqual({ userEnteredValue: { stringValue: "ACR Roofing Division" } });
    expect(vals[colIndex("T") - colIndex("D")]).toEqual({ userEnteredValue: { formulaValue: "=R3+S3" } });
    // A (label) and B (PIF) are adjacent, so they form the first run: two cells.
    expect((runAt(colIndex("A"))!["updateCells"] as { rows: { values: unknown[] }[] }).rows[0]!.values).toHaveLength(2);
    expect(runAt(B)).toBeUndefined();
    // No setup requests when the header already existed.
    expect(reqs.some((r) => r["setDataValidation"])).toBe(false);
  });
  it("lays the tab out on first use: checkboxes, dropdowns, formats, frozen header", () => {
    const plan = planSheet([], [{ from: "2026-09-07", to: "2026-09-13", rows: [] }], { syncedAt: null });
    const reqs = toRequests(plan, 7) as Record<string, unknown>[];
    expect(reqs.filter((r) => r["setDataValidation"]).length).toBeGreaterThan(19);
    expect(reqs.some((r) => JSON.stringify(r).includes('"BOOLEAN"'))).toBe(true);
    expect(reqs.some((r) => JSON.stringify(r).includes("ONE_OF_LIST"))).toBe(true);
    expect(reqs.some((r) => JSON.stringify(r).includes("frozenRowCount"))).toBe(true);
  });
});
