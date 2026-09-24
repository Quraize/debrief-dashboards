/**
 * The Google Sheet planner: pure rules for laying the feed onto the
 * [AUTOMATION] tab without touching the team's cells.
 */
import { describe, it, expect } from "vitest";
import {
  planSheet, parseBlocks, parseWeekLabel, colIndex, colLetter, dateSerial, weekBounds, monthLines, lockDate, lockedBlocks, lockNote, headerColumnMap,
  SYNC_STATUS_STALE, SYNC_STATUS_UNMATCHED, SUMMARY_MARKER, CUMULATIVE_LABEL, PREAPPROVED_LABEL, SYNC_STATUS_LEFT_PREAPPROVED, isPreApproved, type CellWrite,
} from "../src/production/sheetPlan.js";
import { toRequests, lockRequests, pushWeeks } from "../src/production/sheetPush.js";
import type { SheetRow } from "../src/production/weeklyJobSheet.js";
import { MASTER_COLUMNS } from "@allied/shared/weeklyJobSheetMaster";

const HU = colIndex("HU"), HY = colIndex("HY"), AC = colIndex("AC"), R = colIndex("R"), B = colIndex("B"), T = colIndex("T"), AB = colIndex("AB");
const SYNCED_AT = "2026-09-10T14:00:00.000Z";
const NO_MONTH = { syncedAt: SYNCED_AT, monthSummary: false } as const;

const row = (jobId: string, over: Partial<SheetRow> = {}): SheetRow => ({
  jobId, customerId: "9" + jobId, jobNumber: `2609-${jobId}-01`, jobName: null, customer: `Customer ${jobId}`, address: `${jobId} Main St`, city: "Wayne",
  label: `Wayne/${jobId} Main St/Customer ${jobId}`, division: "ACR Roofing Division", trades: "ROOFING", insurance: false,
  stage: "Roof/Siding Scheduled", stageGroup: "production", stageSince: null, salesRep: "Jason Malarchak", sub: "Lucy Construction",
  scheduledInstallDate: "2026-09-09", saleDate: "2026-08-20", completionDate: null, installDates: ["2026-09-09"], nextInstallDate: null,
  visits: [{ day: "2026-09-09", code: "RR" }], gross: 10000, changeOrders: 0, totalRev: 10000, paymentMethod: "Check", deposit: 2000,
  progressPayments: null, paymentsCount: 1, totalPayments: 2000, balanceOwed: 8000, pifStatus: "NO", pifDate: null, jobComplete: false, paidInFull: false, statusTone: "unpaid",
  subScheduled: true, materialVendor: "NCBP",
  containerScheduled: false, actualMaterial: 3000, actualLabor: null, actualCarting: null, actualOther: null, billsCount: 1, bills: [],
  financialsFetchedAt: SYNCED_AT, paymentsFetchedAt: null, billsFetchedAt: null, jpUrl: `https://app.jobprogress.com/#/customer-jobs/9${jobId}/job/${jobId}/overview`,
  ...over,
});
const headerRow = () => { const h: (string | null)[] = []; for (const c of MASTER_COLUMNS) h[colIndex(c.col)] = c.header; return h; };
const cellsOf = (plan: ReturnType<typeof planSheet>) => plan.ops.flatMap((o) => (o.type === "write" ? o.cells : []));
const at = (cells: CellWrite[], r: number, c: number) => cells.find((x) => x.row === r && x.col === c)?.value;
const inserts = (plan: ReturnType<typeof planSheet>) => plan.ops.filter((o) => o.type === "insertRows");
/** The tab after the plan has run: inserts, deletes and writes replayed on a copy. */
const gridAfter = (g: (string | number | boolean | null)[][], plan: ReturnType<typeof planSheet>) => {
  const out = g.map((r) => [...r]);
  for (const o of plan.ops) {
    if (o.type === "insertRows") out.splice(o.at, 0, ...Array.from({ length: o.count }, () => []));
    else if (o.type === "deleteRows") out.splice(o.at, o.count);
    else if (o.type === "write") for (const c of o.cells) { (out[c.row] ??= [])[c.col] = typeof c.value === "object" && c.value !== null ? `=${c.value.formula}` : c.value; }
  }
  return out as never;
};

describe("grid parsing", () => {
  it("reads the tab's week labels and blocks, with the cumulative row when present", () => {
    expect(parseWeekLabel("9/7/2026-9/13/2026")).toEqual({ from: "2026-09-07", to: "2026-09-13" });
    expect(parseWeekLabel("3/30/2026- 4/5/2026")).toEqual({ from: "2026-03-30", to: "2026-04-05" });
    expect(parseWeekLabel("Weekly Total")).toBeNull();
    const grid = [headerRow(), [SUMMARY_MARKER], ["September 2026 — Projected…"], [], ["9/14/2026-9/20/2026"], ["job a"], ["Weekly Total"], [CUMULATIVE_LABEL], [], ["9/7/2026-9/13/2026"], ["job b"], ["job c"], ["Weekly Total"]];
    expect(parseBlocks(grid)).toEqual([
      { labelIdx: 4, from: "2026-09-14", to: "2026-09-20", jobIdx: [5], totalIdx: 6, cumulativeIdx: 7 },
      { labelIdx: 9, from: "2026-09-07", to: "2026-09-13", jobIdx: [10, 11], totalIdx: 12, cumulativeIdx: null },
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
  it("writes the header and one block per week, newest first, with formulas, cumulative rows and unticked checkboxes", () => {
    const plan = planSheet([], [
      { from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2")] },
      { from: "2026-09-14", to: "2026-09-20", rows: [row("3")] },
    ], NO_MONTH);
    expect(plan.summary).toMatchObject({ headerCreated: true, blocksCreated: ["9/14/2026-9/20/2026", "9/7/2026-9/13/2026"], jobsAdded: 3, jobsUpdated: 0 });
    const cells = cellsOf(plan);
    expect(at(cells, 0, 0)).toBe("Town/Address/Customer");
    expect(at(cells, 0, AC)).toBe("Job #");
    // Row 1 label; 2 job 3; 3 total; 4 cumulative; 5 spacer; 6 older label; 7,8 jobs; 9 total; 10 cumulative.
    expect(at(cells, 1, 0)).toBe("9/14/2026-9/20/2026");
    // The job's own cell keeps its text and opens the job in JobProgress.
    expect(at(cells, 2, 0)).toEqual({ formula: 'HYPERLINK("https://app.jobprogress.com/#/customer-jobs/93/job/3/overview","Wayne/3 Main St/Customer 3")' });
    expect(at(cells, 2, HU)).toBe("3");
    expect(at(cells, 2, R)).toBe(10000);
    expect(at(cells, 2, B)).toBe("NO"); // PAID-IN-FULL: not yet
    expect(at(cells, 2, T)).toEqual({ formula: "R3+S3" });
    expect(at(cells, 3, 0)).toBe("Weekly Total");
    expect(at(cells, 3, R)).toEqual({ formula: 'SUMIF(HY3:HY3,"<>Not on the JobProgress calendar this week",R3:R3)' });
    expect(at(cells, 4, 0)).toBe(CUMULATIVE_LABEL);
    expect(at(cells, 6, 0)).toBe("9/7/2026-9/13/2026");
    expect(at(cells, 7, HU)).toBe("1");
    expect(at(cells, 8, HU)).toBe("2");
    expect(at(cells, 9, AB)).toEqual({ formula: 'SUMIF(HY8:HY9,"<>Not on the JobProgress calendar this week",AB8:AB9)' });
    // Both weeks are September: the 9/14 block's cumulative covers its own job row (3) and everything below its
    // cumulative row (6..11), never its own total/cumulative cells (that would be circular), each job once across
    // both ranges; the 9/7 block's covers its own job rows (8..9) only.
    const cum = (at(cells, 4, R) as { formula: string }).formula;
    expect(cum.split("SUMPRODUCT(")).toHaveLength(3);
    expect(cum).toContain("IFERROR(1*R3:R3,0)");
    expect(cum).toContain("IFERROR(1*R6:R11,0)");
    expect(cum).toContain(`(HY6:HY11<>"Not on the JobProgress calendar this week")`);
    // Only LIVE rows count toward a job's occurrences: a stamped twin must not halve the live row.
    expect(cum).toContain('COUNTIFS(AC3:AC3,AC3:AC3&"",HY3:HY3,"<>Not on the JobProgress calendar this week")+COUNTIFS(AC6:AC11,AC3:AC3&"",HY6:HY11,"<>Not on the JobProgress calendar this week")');
    expect(cum).toContain('COUNTIFS(AC3:AC3,AC6:AC11&"",HY3:HY3,"<>Not on the JobProgress calendar this week")+COUNTIFS(AC6:AC11,AC6:AC11&"",HY6:HY11,"<>Not on the JobProgress calendar this week")');
    expect(cum).toContain('+(HY6:HY11="Not on the JobProgress calendar this week")))'); // a stamped row never divides by zero
    expect(cum).not.toMatch(/R4\b|R5\b/); // its own total and cumulative rows are not referenced
    const older = (at(cells, 10, R) as { formula: string }).formula;
    expect(older.split("SUMPRODUCT(")).toHaveLength(2);
    expect(older).toContain("IFERROR(1*R8:R9,0)");
    expect(older).not.toContain("R10");
    expect(inserts(plan)).toEqual([{ type: "insertRows", at: 1, count: 5 }, { type: "insertRows", at: 6, count: 6 }]);
  });
});

describe("planSheet on a tab the team has been working in", () => {
  const grid = () => {
    const g: (string | number | boolean | null)[][] = [headerRow()];
    g.push(["9/7/2026-9/13/2026"]);
    const j1: (string | number | boolean | null)[] = []; j1[0] = "Wayne/1 Main St/Customer 1"; j1[B] = true; j1[HU] = 1; j1[R] = 9999; j1[colIndex("BG")] = "call before 8";
    g.push(j1);
    const gone: (string | number | boolean | null)[] = []; gone[0] = "Old Tappan/84 Willow/Denike"; gone[HU] = "77"; gone[colIndex("BG")] = "call before demo";
    g.push(gone);
    const tot: (string | number | boolean | null)[] = []; tot[0] = "Weekly Total"; tot[R] = 9999;
    g.push(tot);
    return g;
  };
  it("updates only the synced cells of a known row, adds the new job before the total, stamps the dropped job, adds the missing cumulative row", () => {
    const plan = planSheet(grid(), [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2")] }], NO_MONTH);
    expect(plan.summary).toMatchObject({ headerCreated: false, blocksCreated: [], jobsAdded: 1, jobsUpdated: 1, jobsNotThisWeek: 1 });
    const cells = cellsOf(plan);
    // Existing job 1 at row 2: money refreshed, PAID-IN-FULL answered, the note untouched.
    expect(at(cells, 2, R)).toBe(10000);
    expect(at(cells, 2, B)).toBe("NO");
    expect(cells.some((c) => c.row === 2 && c.col === colIndex("BG"))).toBe(false);
    expect(cells.some((c) => c.row === 2 && c.col === T)).toBe(false); // formulas are not rewritten on existing rows
    // New job 2 inserted before the total (row 4) → total moves to row 5 and re-sums 2..4; a cumulative row is added at 6.
    expect(inserts(plan)).toEqual([{ type: "insertRows", at: 4, count: 1 }, { type: "insertRows", at: 6, count: 1 }]);
    expect(at(cells, 4, HU)).toBe("2");
    expect(at(cells, 4, B)).toBe("NO");
    expect(at(cells, 5, R)).toEqual({ formula: 'SUMIF(HY3:HY5,"<>Not on the JobProgress calendar this week",R3:R5)' });
    expect(at(cells, 6, 0)).toBe(CUMULATIVE_LABEL);
    expect((at(cells, 6, R) as { formula: string }).formula).toContain("IFERROR(1*R3:R5,0)");
    expect((at(cells, 6, R) as { formula: string }).formula).not.toContain("R6"); // not its own row
    // Denike (row 3) is not in the feed's week: stamped, kept, greyed — and out of the totals via the SUMIF.
    expect(at(cells, 3, HY)).toBe(SYNC_STATUS_STALE);
    // …and nothing about the row's formatting is touched: the team's colours stay.
    expect(plan.ops.some((o) => o.type === "style" && o.rows.some((r) => r.row === 3))).toBe(false);
    expect(plan.summary.weeks[0]).toMatchObject({ existing: true, added: ["Wayne/2 Main St/Customer 2"], updated: ["Wayne/1 Main St/Customer 1"], notThisWeek: ["Old Tappan/84 Willow/Denike"] });
  });
  it("removes a stale copy that carries nothing hand-filled, and keeps one the team wrote in", () => {
    // Two rows the feed no longer places in this week: one untouched (checkbox defaults only), one with a manufacturer typed in.
    const g = grid();
    // The real Faggello row: synced money, a synced tick, and the ledger FORMULAS' computed results (BM..BS), which are the sheet's, not the team's.
    const empty: (string | number | boolean | null)[] = []; empty[0] = "Teaneck/380 Woods Road/Faggello"; empty[HU] = "88"; empty[B] = "NO"; empty[colIndex("D")] = false; empty[colIndex("AJ")] = true; empty[R] = 27971;
    empty[colIndex("BH")] = 4254.77; empty[colIndex("BM")] = 6639.77; empty[colIndex("BN")] = 21331.23; empty[colIndex("BO")] = 0.763; empty[colIndex("BR")] = 0; empty[colIndex("BS")] = 0;
    const typed: (string | number | boolean | null)[] = []; typed[0] = "Fair Lawn/1 Elm/Smith"; typed[HU] = "99"; typed[colIndex("AE")] = "GAF";
    g.splice(3, 0, empty, typed);   // rows 3 and 4, before Denike (now 5) and the total (now 6)
    // Off by default: every stale row is stamped and kept, nothing is deleted.
    const kept = planSheet(g.map((r) => [...r]), [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], NO_MONTH);
    expect(kept.ops.some((o) => o.type === "deleteRows")).toBe(false);
    expect(kept.summary).toMatchObject({ jobsRemoved: 0, jobsNotThisWeek: 3 });
    const plan = planSheet(g, [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { ...NO_MONTH, removeEmptyStale: true });
    // Faggello (row 3) goes; AJ is a synced tick and B a synced answer, so they do not count as hand-filled.
    expect(plan.ops.filter((o) => o.type === "deleteRows")).toEqual([{ type: "deleteRows", at: 3, count: 1 }]);
    expect(plan.summary).toMatchObject({ jobsRemoved: 1, jobsNotThisWeek: 2 });
    expect(plan.summary.weeks[0]).toMatchObject({ removed: ["Teaneck/380 Woods Road/Faggello"], notThisWeek: ["Fair Lawn/1 Elm/Smith", "Old Tappan/84 Willow/Denike"] });
    // Ops run in order: Smith (row 4) and Denike (row 5) are stamped first, THEN row 3 is deleted and they
    // shift up to 3 and 4. The total, written after the re-read, already uses the final rows: 2..4, at row 5.
    const cells = cellsOf(plan);
    expect(at(cells, 4, HY)).toBe(SYNC_STATUS_STALE);
    expect(at(cells, 5, HY)).toBe(SYNC_STATUS_STALE);
    expect(plan.ops.findIndex((o) => o.type === "deleteRows")).toBeGreaterThan(plan.ops.findIndex((o) => o.type === "write" && o.cells.some((c) => c.value === SYNC_STATUS_STALE)));
    expect(at(cells, 5, R)).toEqual({ formula: 'SUMIF(HY3:HY5,"<>Not on the JobProgress calendar this week",R3:R5)' });
    // And the sheet request is a row deletion at that index.
    const reqs = toRequests(plan, 5) as Record<string, Record<string, unknown>>[];
    expect(reqs.find((r) => r["deleteDimension"])!["deleteDimension"]).toEqual({ range: { sheetId: 5, dimension: "ROWS", startIndex: 3, endIndex: 4 } });
  });
  it("puts a missing older week after the existing block and a newer one before it", () => {
    const older = planSheet(grid(), [{ from: "2026-08-31", to: "2026-09-06", rows: [row("5")] }], NO_MONTH);
    expect(inserts(older)).toEqual([{ type: "insertRows", at: 6, count: 5 }]);
    const newer = planSheet(grid(), [{ from: "2026-09-14", to: "2026-09-20", rows: [row("6")] }], NO_MONTH);
    expect(inserts(newer)).toEqual([{ type: "insertRows", at: 1, count: 5 }]);
    expect(at(cellsOf(newer), 1, 0)).toBe("9/14/2026-9/20/2026");
  });
  it("is idempotent: a second pass over its own output changes nothing structural", () => {
    const first = planSheet([], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { syncedAt: SYNCED_AT, today: "2026-09-10" });
    // Materialise the first plan into a grid.
    const g: (string | number | boolean | null)[][] = [];
    for (const op of first.ops) {
      if (op.type === "insertRows") g.splice(op.at, 0, ...Array.from({ length: op.count }, () => [] as (string | number | boolean | null)[]));
      if (op.type === "write") for (const c of op.cells) { (g[c.row] ??= [])[c.col] = typeof c.value === "object" && c.value ? `=${c.value.formula}` : c.value; }
    }
    const second = planSheet(g, [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], { syncedAt: SYNCED_AT, today: "2026-09-10" });
    expect(inserts(second)).toEqual([]);
    expect(second.summary).toMatchObject({ headerCreated: false, summaryCreated: false, blocksCreated: [], jobsAdded: 0, jobsUpdated: 1, jobsNotThisWeek: 0 });
  });
});

describe("month at a glance", () => {
  const rows = [
    row("1", { visits: [{ day: "2026-09-02", code: "RR" }], stage: "Production Started", totalRev: 10000, gross: 10000 }),   // Sept, started
    row("2", { visits: [{ day: "2026-09-09", code: "RR" }], stage: "Roof/Siding Scheduled", totalRev: 20000, gross: 20000 }), // Sept, date passed but not started
    row("3", { visits: [{ day: "2026-09-25", code: "SR" }], stage: "Roof/Siding Scheduled", totalRev: 5000, gross: 5000 }),   // Sept, upcoming
    row("4", { visits: [{ day: "2026-09-11", code: "MS REPAIR" }], stage: "Production Started", totalRev: 900, gross: 900 }), // service call: not an install
    row("5", { visits: [{ day: "2026-08-20", code: "RR" }], stage: "COMPLETED NEED FINAL PAYMENT!!", totalRev: 7000, gross: 7000 }), // August, started
  ];
  it("counts installs scheduled in the month, and those already started, for this month and last", () => {
    const lines = monthLines(rows, "2026-09-10");
    expect(lines.map((l) => [l.label, l.jobs, l.totalRev])).toEqual([
      ["September 2026 — Projected: 3 jobs with an install scheduled this month, $35,000", 3, 35000],
      ["September 2026 — Started: 1 job with the install started (in production), $10,000", 1, 10000],
      ["August 2026 — Projected: 1 job with an install scheduled this month, $7,000", 1, 7000],
      ["August 2026 — Started: 1 job with the install started (in production), $7,000", 1, 7000],
    ]);
  });
  it("sits under the header, above the first week, and is rewritten in place on later pushes", () => {
    const first = planSheet([], [{ from: "2026-09-07", to: "2026-09-13", rows: [rows[1]!] }], { syncedAt: SYNCED_AT, today: "2026-09-10", allRows: rows });
    expect(first.summary.summaryCreated).toBe(true);
    expect(first.summary.months).toHaveLength(4);
    const cells = cellsOf(first);
    expect(at(cells, 1, 0)).toBe(SUMMARY_MARKER);
    expect(at(cells, 2, 0)).toContain("September 2026 — Projected");
    expect(at(cells, 2, T)).toBe(35000);
    expect(at(cells, 5, 0)).toContain("August 2026 — Started");
    // marker + 4 lines + spacer, then the Sales Pre-Approved block (label + spacer; no unscheduled jobs here), then the first week.
    expect(at(cells, 7, 0)).toBe(PREAPPROVED_LABEL);
    expect(at(cells, 9, 0)).toBe("9/7/2026-9/13/2026");
    expect(inserts(first)).toEqual([{ type: "insertRows", at: 1, count: 6 }, { type: "insertRows", at: 7, count: 2 }, { type: "insertRows", at: 9, count: 5 }]);
    // Second pass: the block already exists; values are rewritten, nothing inserted for it.
    const g: (string | number | boolean | null)[][] = [];
    for (const op of first.ops) {
      if (op.type === "insertRows") g.splice(op.at, 0, ...Array.from({ length: op.count }, () => [] as (string | number | boolean | null)[]));
      if (op.type === "write") for (const c of op.cells) { (g[c.row] ??= [])[c.col] = typeof c.value === "object" && c.value ? `=${c.value.formula}` : c.value; }
    }
    const second = planSheet(g, [{ from: "2026-09-07", to: "2026-09-13", rows: [rows[1]!] }], { syncedAt: SYNCED_AT, today: "2026-09-11", allRows: rows });
    expect(second.summary.summaryCreated).toBe(false);
    expect(inserts(second)).toEqual([]);
    expect(at(cellsOf(second), 1, 0)).toBe(SUMMARY_MARKER);
  });
});

describe("toRequests", () => {
  it("turns the plan into ordered Sheets requests, writing only adjacent runs of cells", () => {
    const plan = planSheet([headerRow(), ["9/7/2026-9/13/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], NO_MONTH);
    const reqs = toRequests(plan, 42) as Record<string, Record<string, unknown>>[];
    expect(reqs[0]).toHaveProperty("insertDimension");
    expect((reqs[0]!["insertDimension"] as Record<string, unknown>)["range"]).toEqual({ sheetId: 42, dimension: "ROWS", startIndex: 2, endIndex: 3 });
    const updates = reqs.filter((r) => r["updateCells"]);
    expect(updates.length).toBeGreaterThan(3);
    for (const u of updates) expect((u["updateCells"] as Record<string, unknown>)["fields"]).toBe("userEnteredValue");
    // On the new row, C (no PIF date yet) is skipped, so A..B is one run and D..U another:
    // seven checkboxes, then the synced job columns through Payment Method.
    const runAt = (col: number) => updates.find((u) => (u["updateCells"] as { start: { columnIndex: number; rowIndex: number } }).start.columnIndex === col && (u["updateCells"] as { start: { rowIndex: number } }).start.rowIndex === 2);
    const du = runAt(colIndex("D"))!;
    const vals = (du["updateCells"] as { rows: { values: { userEnteredValue: unknown }[] }[] }).rows[0]!.values;
    expect(vals).toHaveLength(colIndex("U") - colIndex("D") + 1);
    expect(vals[0]).toEqual({ userEnteredValue: { boolValue: false } });
    expect(vals[colIndex("K") - colIndex("D")]).toEqual({ userEnteredValue: { stringValue: "ACR Roofing Division" } });
    expect(vals[colIndex("T") - colIndex("D")]).toEqual({ userEnteredValue: { formulaValue: "=R3+S3" } });
    expect((runAt(colIndex("A"))!["updateCells"] as { rows: { values: unknown[] }[] }).rows[0]!.values).toHaveLength(2);
    expect(runAt(B)).toBeUndefined();
    // No setup requests when the header already existed and the tab is full size.
    expect(reqs.some((r) => r["setDataValidation"])).toBe(false);
  });
  it("lays the tab out on first use: widens a fresh 26×1000 tab, then checkboxes, dropdowns, formats, frozen header", () => {
    const plan = planSheet([], [{ from: "2026-09-07", to: "2026-09-13", rows: [] }], NO_MONTH);
    const reqs = toRequests(plan, 7, { rowCount: 1000, columnCount: 26 }) as Record<string, unknown>[];
    expect(reqs[0]).toEqual({ appendDimension: { sheetId: 7, dimension: "COLUMNS", length: 234 - 26 } });
    expect(reqs[1]).toEqual({ appendDimension: { sheetId: 7, dimension: "ROWS", length: 5000 - 1000 } });
    expect(toRequests(plan, 7, { rowCount: 5000, columnCount: 234 }).some((r) => (r as Record<string, unknown>)["appendDimension"])).toBe(false);
    expect(reqs.filter((r) => r["setDataValidation"]).length).toBeGreaterThan(19);
    expect(reqs.some((r) => JSON.stringify(r).includes('"BOOLEAN"'))).toBe(true);
    expect(reqs.some((r) => JSON.stringify(r).includes("ONE_OF_LIST"))).toBe(true);
    expect(reqs.some((r) => JSON.stringify(r).includes("frozenRowCount"))).toBe(true);
  });
});

describe("column A links to the job", () => {
  it("writes the label as a link on new and existing rows, plain when the job has no URL, and leaves the tab's own rows alone", () => {
    const grid = [headerRow(), ["9/7/2026-9/13/2026"], ["Wayne/1 Main St/Customer 1", null, null, null, ...Array(HU - 4).fill(null), "1"], ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2", { jpUrl: null })] }], NO_MONTH);
    const cells = cellsOf(plan);
    expect(at(cells, 2, 0)).toEqual({ formula: 'HYPERLINK("https://app.jobprogress.com/#/customer-jobs/91/job/1/overview","Wayne/1 Main St/Customer 1")' });
    expect(at(cells, 3, 0)).toBe("Wayne/2 Main St/Customer 2"); // no URL: plain text, as before
    // The tab's own rows stay plain text: the Weekly Total moved down to row 4 by the insert.
    expect(at(cells, 4, 0)).toBe("Weekly Total");
    // A quote in the customer's name is doubled so the formula survives it.
    const quoted = cellsOf(planSheet(grid, [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1", { label: 'Wayne/1 Main St/Bob "Big Bob" Jones' })] }], NO_MONTH));
    expect(at(quoted, 2, 0)).toEqual({ formula: 'HYPERLINK("https://app.jobprogress.com/#/customer-jobs/91/job/1/overview","Wayne/1 Main St/Bob ""Big Bob"" Jones")' });
  });
});

describe("PAID-IN-FULL — columns B..D", () => {
  const C = colIndex("C"), D = colIndex("D");
  const paid = row("1", { stage: "Paid New Roof", balanceOwed: 0, totalPayments: 10000, pifStatus: "YES", pifDate: "2026-09-10", jobComplete: true, paidInFull: true, statusTone: "paid" });
  const cancelled = row("3", { stage: "Cancel: NO FOLLOW UP(MGR APPR)", pifStatus: null, pifDate: null, jobComplete: false, paidInFull: false, statusTone: null });
  it("renames the team's PIF heading once, drops its checkbox rule, and colours the B cell green for YES and red for NO", () => {
    const tab = headerRow(); tab[B] = "PIF";
    const grid = [tab, ["9/7/2026-9/13/2026"], ["Wayne/1 Main St/Customer 1", true, null, false, ...Array(HU - 4).fill(null), "1"], ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-07", to: "2026-09-13", rows: [paid, row("2"), cancelled] }], NO_MONTH);
    const cells = cellsOf(plan);
    expect(at(cells, 0, B)).toBe("PAID-IN-FULL");
    expect(plan.summary.headersRenamed).toEqual([{ from: "PIF", to: "PAID-IN-FULL", col: "B" }]);
    expect(plan.ops.filter((o) => o.type === "clearValidation")).toEqual([{ type: "clearValidation", col: B }]);
    // The existing row (row 2) is updated: YES, PIF date, completed tick.
    expect(at(cells, 2, B)).toBe("YES");
    expect(at(cells, 2, C)).toBe(dateSerial("2026-09-10"));
    expect(at(cells, 2, D)).toBe(true);
    const styles = plan.ops.flatMap((o) => (o.type === "style" ? o.rows : []));
    expect(styles).toContainEqual({ row: 2, style: "paid", cols: [B, B + 1] });
    // New rows: job 2 (row 3) is NO in red with D unticked; the cancelled job (row 4) is left blank and uncoloured.
    expect(at(cells, 3, B)).toBe("NO"); expect(at(cells, 3, C)).toBeUndefined(); expect(at(cells, 3, D)).toBe(false);
    expect(styles).toContainEqual({ row: 3, style: "unpaid", cols: [B, B + 1] });
    expect(at(cells, 4, B)).toBeUndefined();
    expect(styles.some((s) => s.row === 4 && s.cols)).toBe(false);
    // And the requests: validation removed on the body of B, the colour on the B cell alone with its text format.
    const reqs = toRequests(plan, 7) as Record<string, Record<string, unknown>>[];
    expect(reqs.find((r) => r["setDataValidation"])!["setDataValidation"]).toEqual({ range: { sheetId: 7, startRowIndex: 1, endRowIndex: 5000, startColumnIndex: B, endColumnIndex: B + 1 } });
    const tone = reqs.find((r) => r["repeatCell"] && (r["repeatCell"]!["range"] as { startRowIndex: number; startColumnIndex: number }).startRowIndex === 2 && (r["repeatCell"]!["range"] as { startColumnIndex: number }).startColumnIndex === B)!["repeatCell"] as Record<string, unknown>;
    expect(tone["fields"]).toBe("userEnteredFormat(backgroundColor,textFormat)");
    expect(tone["range"]).toEqual({ sheetId: 7, startRowIndex: 2, endRowIndex: 3, startColumnIndex: B, endColumnIndex: B + 1 });
  });
  it("clears the TRUE/FALSE the checkbox days left on label, total, spacer and stale rows, but not a lock note", () => {
    const grid = [headerRow(),
      ["9/14/2026-9/20/2026", "FALSE"], ["Wayne/1 Main St/Customer 1", false, null, false, ...Array(HU - 4).fill(null), "1"], ["Weekly Total", "FALSE"], [CUMULATIVE_LABEL, false], [null, "FALSE"],
      ["9/7/2026-9/13/2026", lockNote("2026-09-07")], ["Wayne/9 Main St/Customer 9", "TRUE", null, true, ...Array(HU - 4).fill(null), "9"], ["Weekly Total", "FALSE"], [CUMULATIVE_LABEL, "FALSE"]];
    const plan = planSheet(grid, [{ from: "2026-09-14", to: "2026-09-20", rows: [row("1")] }], { ...NO_MONTH, today: "2026-09-16" });
    const cells = cellsOf(plan);
    expect(at(cells, 2, B)).toBe("NO"); // the matched job answers
    // Every other TRUE/FALSE in B goes — including the stale job 9's hand tick — and the lock note stays.
    const cleared = cells.filter((c) => c.col === B && c.value === null).map((c) => c.row).sort((a, b) => a - b);
    expect(cleared).toEqual([1, 3, 4, 5, 7, 8, 9]);
    expect(cells.some((c) => c.row === 6 && c.col === B)).toBe(false);
    expect(plan.summary.checkboxLeftoversCleared).toBe(7);
  });
  it("clears B for a cancelled job on a known row, and does not rename a heading already renamed", () => {
    const grid = [headerRow(), ["9/7/2026-9/13/2026"], ["Wayne/3 Main St/Customer 3", false, null, true, ...Array(HU - 4).fill(null), "3"], ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-07", to: "2026-09-13", rows: [cancelled] }], NO_MONTH);
    const cells = cellsOf(plan);
    expect(at(cells, 0, B)).toBeUndefined();
    expect(plan.summary.headersRenamed).toEqual([]);
    expect(plan.ops.some((o) => o.type === "clearValidation")).toBe(false);
    expect(cells.find((c) => c.row === 2 && c.col === B)).toEqual({ row: 2, col: B, value: null });
    expect(at(cells, 2, D)).toBe(false);
  });
});

describe("rows pasted from the old sheet (no JobProgress ID)", () => {
  const AC = colIndex("AC"), BG = colIndex("BG"), HV = colIndex("HV");
  const pasted = (label: string, over: Record<number, string | number | boolean> = {}) => {
    const r: (string | number | boolean | null)[] = []; r[0] = label; r[R] = 11111; r[BG] = "hand note";
    for (const [k, v] of Object.entries(over)) r[Number(k)] = v;
    return r;
  };
  const week = (rows: SheetRow[]) => [{ from: "2026-09-07", to: "2026-09-13", rows }];

  it("takes over a pasted row for the same job by its text, writing the ID and the money and leaving the team's cells", () => {
    const grid = [headerRow(), ["9/7/2026-9/13/2026"], pasted("Wayne/1 Main St/Customer 1"), ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, week([row("1")]), NO_MONTH);
    expect(inserts(plan)).toEqual([]);                                    // no twin added
    expect(plan.summary).toMatchObject({ jobsAdopted: 1, jobsAdded: 0, jobsUpdated: 0, jobsUnmatched: 0, jobsElsewhere: 0 });
    expect(plan.summary.weeks[0]).toMatchObject({ adopted: ["Wayne/1 Main St/Customer 1"] });
    const cells = cellsOf(plan);
    expect(at(cells, 2, HU)).toBe("1");                                   // the ID, so next time it matches like any row
    expect(at(cells, 2, R)).toBe(10000);                                  // JobProgress's gross replaces the hand-typed 11111
    expect(cells.some((c) => c.row === 2 && c.col === BG)).toBe(false);  // the hand note is untouched
    expect(at(cells, 3, R)).toEqual({ formula: 'SUMIF(HY3:HY3,"<>Not on the JobProgress calendar this week",R3:R3)' });
  });

  it("matches by Job # when the text differs, and refuses an ambiguous match", () => {
    // Different wording in A, but the job number in AC settles it.
    const byNumber = planSheet([headerRow(), ["9/7/2026-9/13/2026"], pasted("WAYNE - 1 Main Street - Cust. One", { [AC]: "2609-1-01" }), ["Weekly Total"], [CUMULATIVE_LABEL]], week([row("1")]), NO_MONTH);
    expect(byNumber.summary.jobsAdopted).toBe(1);
    expect(at(cellsOf(byNumber), 2, HU)).toBe("1");
    // Two pasted rows with the same text and one feed job: neither is adopted; the job is added and both are flagged.
    const twins = planSheet([headerRow(), ["9/7/2026-9/13/2026"], pasted("Wayne/1 Main St/Customer 1"), pasted("Wayne/1 Main St/Customer 1"), ["Weekly Total"], [CUMULATIVE_LABEL]], week([row("1")]), NO_MONTH);
    expect(twins.summary).toMatchObject({ jobsAdopted: 0, jobsAdded: 1, jobsUnmatched: 2 });
    const tc = cellsOf(twins);
    expect(at(tc, 2, HY)).toBe(SYNC_STATUS_UNMATCHED); expect(at(tc, 3, HY)).toBe(SYNC_STATUS_UNMATCHED);
    // Two feed jobs at one address (a contractor) and one pasted row: the text names two jobs, so nothing is adopted.
    const sameAddress = planSheet([headerRow(), ["9/7/2026-9/13/2026"], pasted("Wayne/1 Main St/Customer 1"), ["Weekly Total"], [CUMULATIVE_LABEL]],
      week([row("1"), row("2", { label: "Wayne/1 Main St/Customer 1", jobNumber: null })]), NO_MONTH);
    expect(sameAddress.summary).toMatchObject({ jobsAdopted: 0, jobsAdded: 2, jobsUnmatched: 1 });
  });

  it("lets JobProgress's install date decide the week: a pasted row in the wrong block is stamped stale so the revenue counts once", () => {
    // The team pasted Customer 1 under 9/7; JobProgress has its install in the week of 9/14.
    const grid = [headerRow(),
      ["9/14/2026-9/20/2026"], ["Weekly Total"], [CUMULATIVE_LABEL],
      ["9/7/2026-9/13/2026"], pasted("Wayne/1 Main St/Customer 1"), ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-14", to: "2026-09-20", rows: [row("1")] }, { from: "2026-09-07", to: "2026-09-13", rows: [] }], NO_MONTH);
    expect(plan.summary).toMatchObject({ jobsAdded: 1, jobsAdopted: 0, jobsElsewhere: 1, jobsUnmatched: 0 });
    expect(plan.summary.weeks.find((w) => w.label === "9/7/2026-9/13/2026")).toMatchObject({ elsewhere: ["Wayne/1 Main St/Customer 1 → 9/14/2026-9/20/2026"] });
    const cells = cellsOf(plan);
    // The job is written into the 9/14 block (inserted at row 2)…
    expect(at(cells, 2, HU)).toBe("1"); expect(at(cells, 2, R)).toBe(10000);
    // …and the pasted row (now row 6 after the insert) is stamped stale with its ID and link, so the SUMIF leaves it out here.
    expect(at(cells, 6, HU)).toBe("1"); expect(at(cells, 6, HY)).toBe(SYNC_STATUS_STALE); expect(at(cells, 6, HV)).toContain("/job/1/");
    expect(plan.ops.some((o) => o.type === "style" && o.rows.some((r) => r.row === 6))).toBe(false);   // no formatting written to a pasted row
    // A pasted row nobody in the feed knows is flagged, not touched.
    const lost = planSheet([headerRow(), ["9/7/2026-9/13/2026"], pasted("Nowhere/0 No St/Nobody"), ["Weekly Total"], [CUMULATIVE_LABEL]], week([]), NO_MONTH);
    expect(lost.summary).toMatchObject({ jobsUnmatched: 1, jobsElsewhere: 0 });
    expect(at(cellsOf(lost), 2, HY)).toBe(SYNC_STATUS_UNMATCHED);
  });
});

describe("Sales Pre-Approved / Unscheduled", () => {
  const AE = colIndex("AE"), BG = colIndex("BG");
  const PRE = { syncedAt: SYNCED_AT, monthSummary: false, preApproved: true, today: "2026-09-23", lockWeeks: false } as const;
  // Sold, no install visit, stage not scheduled: pre-approved.
  const unsched = (id: string, over: Partial<SheetRow> = {}) => row(id, { stage: "Install Accepted-> SUBMIT SS", stageGroup: "project_won", visits: [], installDates: [], scheduledInstallDate: null, saleDate: "2026-09-16", ...over });

  it("reads the Sold Pipeline's Unscheduled rule off a sheet row", () => {
    expect(isPreApproved(unsched("1"), "2026-09-23")).toBe(true);
    expect(isPreApproved(unsched("1", { visits: [{ day: "2026-10-06", code: "RR" }] }), "2026-09-23")).toBe(false);        // on the calendar
    expect(isPreApproved(unsched("1", { visits: [{ day: "2026-09-10", code: "MSSA" }] }), "2026-09-23")).toBe(true);       // a site assessment is not a date
    expect(isPreApproved(unsched("1", { stage: "Repairs Scheduled" }), "2026-09-23")).toBe(false);                          // the stage says booked
    expect(isPreApproved(unsched("1", { stage: "Paid New Roof" }), "2026-09-23")).toBe(false);
    expect(isPreApproved(unsched("1", { saleDate: null }), "2026-09-23")).toBe(false);
    // Parked on a carrier, a deposit or credit: stays on the pipeline page, not in the block.
    for (const s of ["Accepted/INS Claim Pending", "Accepted/No Deposit/Finance", "On Hold/Credit DQ (MGR APPR)"]) expect(isPreApproved(unsched("1", { stage: s }), "2026-09-23"), s).toBe(false);
    for (const s of ["Sales Review", "Production Review", "Approved New Installs", "Approved Service/Repairs", "Repair Accepted-> SUBMIT SS"]) expect(isPreApproved(unsched("1", { stage: s }), "2026-09-23"), s).toBe(true);
  });

  it("creates the block under the header on an empty week list, oldest sale first, with totals on its green label row", () => {
    const grid = [headerRow(), ["9/7/2026-9/13/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-07", to: "2026-09-13", rows: [] }],
      { ...PRE, allRows: [unsched("1", { saleDate: "2026-09-16", gross: 26749, totalRev: 26749 }), unsched("2", { saleDate: "2026-08-14", gross: 34779, totalRev: 34779 })] });
    const cells = cellsOf(plan);
    expect(at(cells, 1, 0)).toBe(PREAPPROVED_LABEL);
    expect(at(cells, 2, HU)).toBe("2"); expect(at(cells, 3, HU)).toBe("1");          // August sale first
    expect(at(cells, 1, R)).toEqual({ formula: "SUM(R3:R4)" });
    expect(plan.summary.preApproved).toMatchObject({ created: true, jobs: 2, added: [expect.any(String), expect.any(String)], left: [] });
    expect(plan.ops.some((o) => o.type === "style" && o.rows.some((r) => r.row === 1 && r.style === "label"))).toBe(true);   // yellow, black text
    // The week block moved down past the block and its spacer, untouched.
    expect(parseBlocks(gridAfter(grid, plan))[0]).toMatchObject({ from: "2026-09-07", labelIdx: 5 });
  });

  it("moves a job out when it is scheduled, carrying what the team typed into its week row", () => {
    // The block holds job 1 with a manufacturer and a note typed in; job 1 now has an install in the week of 9/28.
    const grid: (string | number | boolean | null)[][] = [headerRow(), [PREAPPROVED_LABEL]];
    const r1: (string | number | boolean | null)[] = []; r1[0] = "Wayne/1 Main St/Customer 1"; r1[HU] = "1"; r1[AE] = "GAF"; r1[BG] = "customer wants Charcoal";
    grid.push(r1, [], ["9/21/2026-9/27/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]);
    const scheduled = row("1", { visits: [{ day: "2026-09-29", code: "RR" }], installDates: ["2026-09-29"] });
    const plan = planSheet(grid, [{ from: "2026-09-28", to: "2026-10-04", rows: [scheduled] }, { from: "2026-09-21", to: "2026-09-27", rows: [] }],
      { ...PRE, allRows: [scheduled] });
    expect(plan.summary.preApproved).toMatchObject({ jobs: 0, left: ["Wayne/1 Main St/Customer 1"], carried: ["Wayne/1 Main St/Customer 1"], kept: [] });
    const cells = cellsOf(plan);
    // The sheet after the push: the new 9/28 week block's job row carries GAF and the note.
    const after = gridAfter(grid, plan) as (string | number | boolean | null)[][];
    const wk = parseBlocks(after).find((b) => b.from === "2026-09-28")!;
    const jobRow = wk.jobIdx[0]!;
    expect(after[jobRow]![HU]).toBe("1");
    expect(after[jobRow]![AE]).toBe("GAF");
    expect(after[jobRow]![BG]).toBe("customer wants Charcoal");
    // And no pre-approved row for job 1 is left.
    expect(after.filter((r) => r[HU] === "1")).toHaveLength(1);
    // The pre-approved row was deleted and the empty block now totals 0.
    expect(plan.ops.some((o) => o.type === "deleteRows")).toBe(true);
    expect(cells.filter((c) => c.row === 1 && c.col === R).pop()?.value).toBe(0);
  });

  it("keeps a leaving row that carries the team's cells when its week is not in this push, and stamps it", () => {
    const grid: (string | number | boolean | null)[][] = [headerRow(), [PREAPPROVED_LABEL]];
    const r1: (string | number | boolean | null)[] = []; r1[0] = "Wayne/1 Main St/Customer 1"; r1[HU] = "1"; r1[BG] = "call first";
    const r2: (string | number | boolean | null)[] = []; r2[0] = "Wayne/2 Main St/Customer 2"; r2[HU] = "2";     // nothing typed
    grid.push(r1, r2, [], ["9/21/2026-9/27/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]);
    // Both jobs are now scheduled for November — outside this push's weeks.
    const s1 = row("1", { visits: [{ day: "2026-11-10", code: "RR" }] }), s2 = row("2", { visits: [{ day: "2026-11-11", code: "RR" }] });
    const plan = planSheet(grid, [{ from: "2026-09-21", to: "2026-09-27", rows: [] }], { ...PRE, allRows: [s1, s2] });
    expect(plan.summary.preApproved).toMatchObject({ left: ["Wayne/2 Main St/Customer 2"], kept: ["Wayne/1 Main St/Customer 1"] });
    expect(at(cellsOf(plan), 2, HY)).toBe(SYNC_STATUS_LEFT_PREAPPROVED);
    expect(plan.ops.filter((o) => o.type === "deleteRows")).toEqual([{ type: "deleteRows", at: 3, count: 1 }]);
  });

  it("updates a job already in the block in place, and leaves a row the team pasted there alone", () => {
    const grid: (string | number | boolean | null)[][] = [headerRow(), [PREAPPROVED_LABEL]];
    const r1: (string | number | boolean | null)[] = []; r1[0] = "Wayne/1 Main St/Customer 1"; r1[HU] = "1"; r1[R] = 1;
    const mine: (string | number | boolean | null)[] = []; mine[0] = "Somebody's own note row";
    grid.push(r1, mine, [], ["9/21/2026-9/27/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]);
    const plan = planSheet(grid, [{ from: "2026-09-21", to: "2026-09-27", rows: [] }], { ...PRE, allRows: [unsched("1")] });
    const cells = cellsOf(plan);
    expect(at(cells, 2, R)).toBe(10000);
    expect(cells.some((c) => c.row === 3 && c.col !== 0 && c.value !== null && c.col < HU)).toBe(false);
    expect(plan.ops.some((o) => o.type === "deleteRows" || o.type === "insertRows")).toBe(false);
    expect(at(cells, 1, R)).toEqual({ formula: "SUM(R3:R4)" });
  });
});

describe("text the automation writes is black", () => {
  it("styles every own row and the PAID-IN-FULL cell with black text, the pre-approved label yellow", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../src/production/sheetPush.ts", import.meta.url), "utf8");
    const styles = src.slice(src.indexOf("const ROW_STYLES"), src.indexOf("export function toRequests"));
    const colours = [...styles.matchAll(/foregroundColor: rgb\("([0-9A-F]{6})"\)/g)].map((m) => m[1]);
    expect(colours.length).toBeGreaterThanOrEqual(7);
    expect(new Set(colours)).toEqual(new Set(["000000"]));
    expect(styles).toMatch(/label: \{ backgroundColor: rgb\("FFFF00"\)/);
  });
  it("re-asserts the label, total and cumulative rows of every week each push", () => {
    const grid = [headerRow(), ["9/14/2026-9/20/2026"], ["Weekly Total"], [CUMULATIVE_LABEL], [], ["9/7/2026-9/13/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [{ from: "2026-09-14", to: "2026-09-20", rows: [] }], NO_MONTH);
    const styled = plan.ops.flatMap((o) => (o.type === "style" ? o.rows.map((r) => `${r.row}:${r.style}`) : []));
    for (const s of ["1:label", "2:total", "3:cumulative", "5:label", "6:total", "7:cumulative"]) expect(styled).toContain(s);
  });
});

describe("the team's formatting is never touched", () => {
  it("writes formatting only to the rows it creates and to the PAID-IN-FULL cell — never row-wide on a job row", () => {
    const B = colIndex("B");
    const grid = [headerRow(),
      ["9/14/2026-9/20/2026"], ["Weekly Total"], [CUMULATIVE_LABEL],
      ["9/7/2026-9/13/2026"],
      ["Wayne/1 Main St/Customer 1", null, null, null, ...Array(HU - 4).fill(null), "1"],          // known, updated
      ["Old Tappan/84 Willow/Denike", null, null, null, ...Array(HU - 4).fill(null), "77"],          // stale, kept
      ["Fair Lawn/1 Elm/Pasted", ...Array(HU - 1).fill(null)],                                          // pasted, adopted or flagged
      ["Weekly Total"], [CUMULATIVE_LABEL]];
    const plan = planSheet(grid, [
      { from: "2026-09-14", to: "2026-09-20", rows: [row("9")] },                                   // creates rows in the top block
      { from: "2026-09-07", to: "2026-09-13", rows: [row("1"), row("2"), row("3", { label: "Fair Lawn/1 Elm/Pasted" })] },
    ], { ...NO_MONTH, today: "2026-09-18" });
    const labels = new Set<number>();
    for (const b of parseBlocks(plan.ops.length ? grid : grid)) { labels.add(b.labelIdx); if (b.totalIdx !== null) labels.add(b.totalIdx); if (b.cumulativeIdx !== null) labels.add(b.cumulativeIdx); }
    for (const op of plan.ops) {
      if (op.type !== "style") continue;
      for (const r of op.rows) {
        const ownRow = ["label", "total", "cumulative", "summary"].includes(r.style);
        // Either it is one of the planner's own rows, or it is the B-cell tone and nothing wider.
        expect(ownRow || (["paid", "unpaid", "mismatch"].includes(r.style) && r.cols?.[0] === B && r.cols?.[1] === B + 1), JSON.stringify(r)).toBe(true);
      }
    }
    expect(plan.ops.some((o) => o.type === "style")).toBe(true);   // the guard is not vacuous
  });
});

describe("weeks split at a month end", () => {
  const job = (id: string, days: string[]) => row(id, { visits: days.map((day) => ({ day, code: "RR" })), installDates: days });

  it("pushes 9/28–9/30 and 10/1–10/4 as two weeks, a job in the half its install starts, never both", () => {
    const rows = [job("sep", ["2026-09-29"]), job("oct", ["2026-10-02"]), job("span", ["2026-09-30", "2026-10-01"]), job("next", ["2026-10-06"])];
    const weeks = pushWeeks(rows, "2026-09-24", 0, 2, "2026-09-28");
    expect(weeks.map((w) => `${w.from}..${w.to}`)).toEqual(["2026-09-21..2026-09-27", "2026-09-28..2026-09-30", "2026-10-01..2026-10-04", "2026-10-05..2026-10-11"]);
    expect(weeks[1]!.rows.map((r) => r.jobId).sort()).toEqual(["sep", "span"]);     // the two-day job starts 9/30: September's
    expect(weeks[2]!.rows.map((r) => r.jobId)).toEqual(["oct"]);
    expect(weeks[3]!.rows.map((r) => r.jobId)).toEqual(["next"]);
    // Before the cut-over date weeks stay whole.
    expect(pushWeeks(rows, "2026-09-24", 0, 2, "2026-10-05").map((w) => `${w.from}..${w.to}`)).toContain("2026-09-28..2026-10-04");
  });

  it("locks both halves together on the Friday of the week", () => {
    expect(lockDate("2026-09-28")).toBe("2026-10-02");
    expect(lockDate("2026-10-01")).toBe("2026-10-02");
    expect(lockDate("2026-09-21")).toBe("2026-09-25");
  });

  it("relabels a whole-week block already on the tab as the first half, adds the second, and keeps each month's totals apart", () => {
    const grid: (string | number | boolean | null)[][] = [headerRow(), ["9/28/2026-10/4/2026"]];
    const sep: (string | number | boolean | null)[] = []; sep[0] = "Wayne/1 Main St/Customer 1"; sep[HU] = "1";
    const oct: (string | number | boolean | null)[] = []; oct[0] = "Wayne/2 Main St/Customer 2"; oct[HU] = "2";
    grid.push(sep, oct, ["Weekly Total"], [CUMULATIVE_LABEL]);
    const weeks = [{ from: "2026-10-01", to: "2026-10-04", rows: [row("2")] }, { from: "2026-09-28", to: "2026-09-30", rows: [row("1")] }];
    const plan = planSheet(grid, weeks, { ...NO_MONTH, today: "2026-09-24" });
    expect(plan.summary.weeksSplit).toEqual(["9/28/2026-9/30/2026"]);
    const after = gridAfter(grid, plan) as (string | number | boolean | null)[][];
    const blocks = parseBlocks(after);
    expect(blocks.map((b) => `${b.from}..${b.to}`)).toEqual(["2026-10-01..2026-10-04", "2026-09-28..2026-09-30"]);
    // Job 1 is updated where it was; job 2 moves to October's block and its old row is stamped stale in September's.
    expect(blocks[0]!.jobIdx.map((i) => after[i]![HU])).toEqual(["2"]);
    const sepRows = blocks[1]!.jobIdx.map((i) => [after[i]![HU], after[i]![HY]]);
    expect(sepRows).toEqual([["1", "Synced from JobProgress"], ["2", SYNC_STATUS_STALE]]);
    expect(blocks.filter((b) => b.from.startsWith("2026-10")).length).toBe(1);
  });
});

describe("following the tab's headings", () => {
  const P = colIndex("P"), Q = colIndex("Q");
  it("writes a synced value where its heading sits when the tab has moved it, and says so", () => {
    const swapped = headerRow(); swapped[P] = "Sale Date"; swapped[Q] = "Scheduled Install Date";
    const { idx, followed } = headerColumnMap(swapped);
    expect(idx["P"]).toBe(Q); expect(idx["Q"]).toBe(P); expect(idx["R"]).toBe(colIndex("R"));
    expect(followed).toEqual([
      { header: "Scheduled Install Date", template: "P", tab: "Q" },
      { header: "Sale Date", template: "Q", tab: "P" },
    ]);
    const plan = planSheet([swapped, ["9/7/2026-9/13/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], NO_MONTH);
    const cells = cellsOf(plan);
    // Row 2 is the new job: its sale date (8/20) lands under "Sale Date" — now column P — and the install (9/9) under Q.
    expect(at(cells, 2, P)).toBe(dateSerial("2026-08-20"));
    expect(at(cells, 2, Q)).toBe(dateSerial("2026-09-09"));
    expect(plan.summary.columnsFollowed).toHaveLength(2);
    // Formulas keep the template's letters: T is still R+S.
    expect(at(cells, 2, T)).toEqual({ formula: "R3+S3" });
  });
  it("leaves the template alone when the headings match, are missing, or are ambiguous", () => {
    expect(headerColumnMap(headerRow()).followed).toEqual([]);
    expect(headerColumnMap(undefined).idx["P"]).toBe(P);
    const twice = headerRow(); twice[P] = "Sale Date"; twice[Q] = "Sale Date";
    expect(headerColumnMap(twice).followed).toEqual([]); // two "Sale Date" headings: nothing to follow safely
    expect(colLetter(0)).toBe("A"); expect(colLetter(25)).toBe("Z"); expect(colLetter(26)).toBe("AA"); expect(colLetter(colIndex("HU"))).toBe("HU");
    // A plan on a normal tab records nothing followed, and the next plan is not affected by a previous swapped one.
    expect(planSheet([headerRow(), ["9/7/2026-9/13/2026"], ["Weekly Total"], [CUMULATIVE_LABEL]], [{ from: "2026-09-07", to: "2026-09-13", rows: [row("1")] }], NO_MONTH).summary.columnsFollowed).toEqual([]);
  });
});

describe("week locks — read-only from the end of Thursday", () => {
  // A tab with three weeks: next week, this week (9/14–9/20), last week.
  const grid = [
    headerRow(), [SUMMARY_MARKER], ["September 2026 — Projected…"], [],
    ["9/21/2026-9/27/2026"], ["job n"], ["Weekly Total"], [CUMULATIVE_LABEL], [],
    ["9/14/2026-9/20/2026"], ["job a"], ["job b"], ["Weekly Total"], [CUMULATIVE_LABEL], [],
    ["9/7/2026-9/13/2026"], ["job c"], ["Weekly Total"], [CUMULATIVE_LABEL],
  ];

  it("locks at 00:00 Friday of the week, office calendar", () => {
    expect(lockDate("2026-09-14")).toBe("2026-09-18");
    expect(lockNote("2026-09-14")).toMatch(/^🔒 Locked since Fri 9\/18\/2026/);
    // Thursday evening: this week is still open. Friday: locked.
    expect(lockedBlocks(grid, "2026-09-17").map((l) => l.label)).toEqual(["9/7/2026-9/13/2026"]);
    expect(lockedBlocks(grid, "2026-09-18").map((l) => l.label)).toEqual(["9/14/2026-9/20/2026", "9/7/2026-9/13/2026"]);
    // The span covers label through cumulative row, end exclusive.
    expect(lockedBlocks(grid, "2026-09-18")[0]).toMatchObject({ startRow: 9, endRow: 14, since: "2026-09-18" });
  });

  it("locks every past week on the first run, not only the pushed ones, and notes it once on the label row", () => {
    const week = { from: "2026-09-21", to: "2026-09-27", rows: [] as SheetRow[] };
    const plan = planSheet(grid, [week], { ...NO_MONTH, today: "2026-09-18" });
    expect(plan.summary.locks.map((l) => l.label)).toEqual(["9/14/2026-9/20/2026", "9/7/2026-9/13/2026"]);
    const notes = cellsOf(plan).filter((c) => c.col === B && String(c.value).startsWith("🔒"));
    expect(notes.map((c) => c.row)).toEqual([9, 15]);
    // Already noted → not written again.
    const noted = grid.map((r) => [...r]); noted[9]![1] = lockNote("2026-09-14"); noted[15]![1] = lockNote("2026-09-07");
    expect(cellsOf(planSheet(noted, [week], { ...NO_MONTH, today: "2026-09-18" })).filter((c) => c.col === B && String(c.value).startsWith("🔒"))).toHaveLength(0);
    // Off switch.
    expect(planSheet(grid, [week], { ...NO_MONTH, today: "2026-09-18", lockWeeks: false }).summary.locks).toEqual([]);
  });

  it("re-asserts a lock's span after rows shift and leaves an unchanged one alone", () => {
    const locks = lockedBlocks(grid, "2026-09-18");
    const fresh = lockRequests(locks, [], 5, "sa@test", false);
    expect(fresh.added).toBe(2); expect(fresh.updated).toBe(0);
    expect((fresh.requests[0] as Record<string, Record<string, Record<string, unknown>>>)["addProtectedRange"]!["protectedRange"]).toMatchObject({
      range: { sheetId: 5, startRowIndex: 9, endRowIndex: 14 }, description: "Automation lock — week 9/14/2026-9/20/2026",
      warningOnly: false, editors: { users: ["sa@test"], domainUsersCanEdit: false },
    });
    const existing = [
      { protectedRangeId: 1, description: "Automation lock — week 9/14/2026-9/20/2026", range: { sheetId: 5, startRowIndex: 9, endRowIndex: 14 } },
      { protectedRangeId: 2, description: "Automation lock — week 9/7/2026-9/13/2026", range: { sheetId: 5, startRowIndex: 15, endRowIndex: 18 } }, // block grew
    ];
    const steady = lockRequests(locks, existing, 5, "sa@test", false);
    expect(steady.added).toBe(0); expect(steady.updated).toBe(1);
    expect((steady.requests[0] as Record<string, Record<string, unknown>>)["updateProtectedRange"]).toMatchObject({
      protectedRange: { protectedRangeId: 2, range: { startRowIndex: 15, endRowIndex: 19 } }, fields: "range,description,warningOnly",
    });
    // Rows were inserted somewhere above this run: every span is re-asserted.
    expect(lockRequests(locks, existing, 5, "sa@test", true).updated).toBe(2);
    // Locking turned off: every automation lock comes off, someone else's protection stays, nothing is added.
    const theirs = { protectedRangeId: 9, description: "Payroll — do not edit", range: { sheetId: 5, startRowIndex: 40, endRowIndex: 41 } };
    const off = lockRequests(locks, [...existing, theirs], 5, "sa@test", false, true);
    expect(off).toMatchObject({ added: 0, updated: 0, removed: 2 });
    expect(off.requests).toEqual([{ deleteProtectedRange: { protectedRangeId: 1 } }, { deleteProtectedRange: { protectedRangeId: 2 } }]);
  });
});
