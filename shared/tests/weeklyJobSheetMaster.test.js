import { describe, it, expect } from "vitest";
import {
  MASTER_COLUMNS, MASTER_SYNCED, MASTER_MANUAL, MASTER_CHECKBOXES, FILLS, NUM_FMT, columnFormula, weekLabel,
} from "../src/weeklyJobSheetMaster.js";
import { SHEET_COLUMNS } from "../src/weeklyJobSheet.js";

const colIndex = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);

describe("master column map", () => {
  it("lists each tab column once, left to right, through the JP columns at HT..HZ", () => {
    const idx = MASTER_COLUMNS.map((c) => colIndex(c.col));
    expect(new Set(idx).size).toBe(idx.length);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(MASTER_COLUMNS[0].col).toBe("A");
    expect(MASTER_COLUMNS.at(-1).col).toBe("HZ");
    expect(MASTER_COLUMNS.find((c) => c.col === "BS").header).toBe("Actual Dealer Fee %");
  });
  it("fills the same columns the CSV does, plus the JP link columns", () => {
    const csvKeys = SHEET_COLUMNS.filter((c) => c.key).map((c) => c.key).sort();
    const masterKeys = MASTER_SYNCED.map((c) => c.key);
    for (const k of csvKeys) expect(masterKeys).toContain(k);
    expect(masterKeys).toEqual(expect.arrayContaining(["customerId", "jobId", "jpUrl", "syncedAt", "syncStatus"]));
    expect(MASTER_COLUMNS.find((c) => c.col === "AC")).toMatchObject({ key: "jobNumber", header: "Job #" });
  });
  it("keeps every hand-filled column present with a type the team can fill", () => {
    expect(MASTER_MANUAL.length).toBeGreaterThan(40);
    for (const col of MASTER_MANUAL) expect(["text", "check", "date", "money", "pct"]).toContain(col.type);
    expect(MASTER_CHECKBOXES.map((c) => c.col)).toEqual(expect.arrayContaining(["B", "D", "E", "F", "G", "H", "I", "J", "X", "AG", "AI", "AJ", "AK", "AL", "AM", "AQ", "AT", "AU", "BF"]));
    expect(MASTER_COLUMNS.find((c) => c.col === "AE").list).toEqual(["Atlas", "GAF", "Hardie", "Certainteed"]);
  });
  it("fills vendor, container, sub-scheduled and the actual-cost ledger from JobProgress", () => {
    const by = (col) => MASTER_COLUMNS.find((c) => c.col === col);
    expect(by("AD")).toMatchObject({ key: "materialVendor" });
    expect(by("AI")).toMatchObject({ key: "containerScheduled", type: "check" });
    expect(by("AJ")).toMatchObject({ key: "subScheduled", type: "check" });
    expect(["BH", "BI", "BJ", "BL"].map((c) => by(c).key)).toEqual(["actualMaterial", "actualLabor", "actualCarting", "actualOther"]);
    expect(by("BK").key).toBeUndefined(); // dealer fee is not a vendor bill
    expect(columnFormula(by("BM"), 7)).toBe('IF(COUNT(BH7:BL7)=0,"",SUM(BH7:BL7))');
    expect(columnFormula(by("BN"), 7)).toBe('IF(BM7="","",T7-BM7)');
    expect(columnFormula(by("BO"), 7)).toBe('IFERROR(BN7/T7,"")');
  });
  it("puts no dropdown on a synced column, whose JobProgress values are not the tab's short entries", () => {
    for (const col of MASTER_SYNCED) expect(col.list).toBeUndefined();
  });
  it("knows the tab's formula columns and formats", () => {
    const T = MASTER_COLUMNS.find((c) => c.col === "T");
    expect(columnFormula(T, 5)).toBe("R5+S5");
    expect(columnFormula(MASTER_COLUMNS.find((c) => c.col === "AA"), 12)).toBe("SUM(Y12:Z12)");
    expect(columnFormula(MASTER_COLUMNS.find((c) => c.col === "AB"), 12)).toBe("T12-AA12");
    expect(columnFormula(MASTER_COLUMNS.find((c) => c.col === "R"), 12)).toBeNull();
    expect(NUM_FMT.money).toBe('"$"#,##0.00');
    expect(FILLS.cyan).toBe("FF00FFFF");
  });
  it("labels a week the way the tab does", () => {
    expect(weekLabel("2026-09-07", "2026-09-13")).toBe("9/7/2026-9/13/2026");
    expect(weekLabel("2026-09-07", null)).toBe("9/7/2026-…");
    expect(weekLabel(null, null)).toBe("");
  });
});
