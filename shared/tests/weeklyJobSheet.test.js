import { describe, it, expect } from "vitest";
import {
  SHEET_COLUMNS, LINK_COLUMNS, AUTOMATED_COLUMNS, PENDING_COLUMNS,
  totalRevenue, balanceOwed, sheetDate, sheetCell, sheetTable, toSheetCsv, rowLabel,
} from "../src/weeklyJobSheet.js";

const row = (over = {}) => ({
  jobId: "5001", customerId: "9001", jobNumber: "2608-9054-01", customer: "Sam Molano", address: "320 Ivy Place", city: "Paramus",
  division: "ACR Roofing Division", trades: "ROOFING", stage: "COMPLETED NEED FINAL PAYMENT!!", salesRep: "Jason Malarchak",
  sub: "Lucy Construction", scheduledInstallDate: "2026-08-28", saleDate: "2026-08-19",
  gross: 13999, changeOrders: 0, totalRev: 13999, paymentMethod: null, deposit: null, progressPayments: null,
  totalPayments: 2276, balanceOwed: 11723, jpUrl: "https://app.jobprogress.com/#/customer-jobs/9001/job/5001/overview",
  financialsFetchedAt: "2026-09-09T14:05:00.000Z", label: "Paramus/320 Ivy Place/Sam Molano", ...over,
});

describe("column map", () => {
  it("covers A..AB in order, so a CSV pastes over the tab", () => {
    const letters = SHEET_COLUMNS.map((c) => c.col);
    expect(letters).toEqual(["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","AA","AB"]);
    expect(SHEET_COLUMNS).toHaveLength(28);
  });
  it("automates the columns the office asked for and leaves payment detail pending", () => {
    expect(AUTOMATED_COLUMNS.map((c) => c.col)).toEqual(["A","K","L","M","N","O","P","Q","R","S","T","AA","AB"]);
    expect(PENDING_COLUMNS.map((c) => c.header)).toEqual(["Payment Method", "Deposit", "Progress Payment Amounts"]);
  });
});

describe("sheet formulas", () => {
  it("total revenue is gross plus change orders, blank until gross is known", () => {
    expect(totalRevenue(13999, 0)).toBe(13999);
    expect(totalRevenue("4129", "350.5")).toBe(4479.5);
    expect(totalRevenue(4129, null)).toBe(4129);
    expect(totalRevenue(null, 300)).toBeNull();
  });
  it("balance owed is total minus payments, zero for a cancellation", () => {
    expect(balanceOwed(4552, 2276, "Production Started")).toBe(2276);
    expect(balanceOwed(4552, null, "Production Started")).toBe(4552);
    expect(balanceOwed(4552, 2276, "Cancellation")).toBe(0);
    expect(balanceOwed(null, 100, "Production Started")).toBeNull();
  });
});

describe("cell formatting", () => {
  const byKey = (key) => [...SHEET_COLUMNS, ...LINK_COLUMNS].find((c) => c.key === key);
  it("writes dates the American way and money as plain numbers", () => {
    expect(sheetDate("2026-08-05")).toBe("8/5/2026");
    expect(sheetDate("2026-08-05T00:00:00.000Z")).toBe("8/5/2026");
    expect(sheetDate(null)).toBe("");
    expect(sheetCell(byKey("gross"), row())).toBe("13999.00");
    expect(sheetCell(byKey("saleDate"), row())).toBe("8/19/2026");
    expect(sheetCell(byKey("financialsFetchedAt"), row())).toBe("2026-09-09 14:05");
  });
  it("leaves unknown values and hand-filled columns blank, never zero", () => {
    expect(sheetCell(byKey("totalPayments"), row({ totalPayments: null }))).toBe("");
    expect(sheetCell(byKey("deposit"), row())).toBe("");
    expect(sheetCell(SHEET_COLUMNS[1], row())).toBe(""); // PIF checkbox
  });
  it("builds the legacy column-A label from town, address and customer", () => {
    expect(rowLabel(row())).toBe("Paramus/320 Ivy Place/Sam Molano");
    expect(rowLabel(row({ address: null }))).toBe("Paramus/Sam Molano");
  });
});

describe("table and CSV", () => {
  it("puts the job number in A, the stage in M and the balance in AB", () => {
    const [header, first] = sheetTable([row()]);
    expect(header[0]).toBe("Job #");
    expect(header[12]).toBe("Job Stage");
    expect(header[27]).toBe("Balance Owed");
    expect(first[0]).toBe("2608-9054-01");
    expect(first[10]).toBe("ACR Roofing Division");
    expect(first[12]).toBe("COMPLETED NEED FINAL PAYMENT!!");
    expect(first[15]).toBe("8/28/2026");
    expect(first[17]).toBe("13999.00");
    expect(first[27]).toBe("11723.00");
    expect(first[28]).toBe("Paramus/320 Ivy Place/Sam Molano");
    expect(first[30]).toBe("5001");
  });
  it("escapes quotes and keeps one line per job", () => {
    const csv = toSheetCsv([row({ sub: 'Lucy "LC" Construction' })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('"Job #","PIF"')).toBe(true);
    expect(lines[1]).toContain('"Lucy ""LC"" Construction"');
    expect(lines[1].split('","')).toHaveLength(SHEET_COLUMNS.length + LINK_COLUMNS.length);
  });
  it("is empty-safe", () => {
    expect(sheetTable([])).toHaveLength(1);
    expect(toSheetCsv([]).split("\r\n")).toHaveLength(1);
  });
});
