import { describe, it, expect } from "vitest";
import {
  SHEET_COLUMNS, LINK_COLUMNS, AUTOMATED_COLUMNS, PENDING_COLUMNS,
  totalRevenue, balanceOwed, sheetDate, sheetCell, sheetTable, toSheetCsv, rowLabel, paymentBreakdown, jobStatus, PIF_STATUS,
  classifyVendor, vendorShortName, billBreakdown,
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
    expect(letters).toEqual(["A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","AA","AB","AC"]);
    expect(SHEET_COLUMNS).toHaveLength(29);
  });
  it("keeps the office's Town/Address/Customer key in A and puts the job number in AC", () => {
    expect(SHEET_COLUMNS[0]).toMatchObject({ col: "A", key: "label" });
    expect(SHEET_COLUMNS[28]).toMatchObject({ col: "AC", key: "jobNumber", header: "Job #" });
  });
  it("automates every column the office asked for; nothing is pending", () => {
    expect(AUTOMATED_COLUMNS.map((c) => c.col)).toEqual(["A","B","C","D","K","L","M","N","O","P","Q","R","S","T","U","Y","Z","AA","AB","AC"]);
    expect(PENDING_COLUMNS).toEqual([]);
  });
});

describe("paymentBreakdown", () => {
  const pay = (id, amount, date, method, over = {}) => ({ id, amount, date, method, methodLabel: null, status: "applied", canceled: false, ...over });
  it("deposit is the first payment, progress the rest, methods joined the way the sheet writes them", () => {
    const r = paymentBreakdown([
      pay("3", "1276.00", "2026-08-20", "echeque", { methodLabel: "Check" }),
      pay("1", 1000, "2026-08-01", "cash", { methodLabel: "Cash" }),
      pay("2", 500, "2026-08-01", "cash", { methodLabel: "Cash" }),
    ]);
    expect(r).toEqual({ deposit: 1000, progressPayments: 1776, paymentMethod: "Cash/Check", count: 3 });
  });
  it("ignores canceled, voided and non-positive entries; falls back to the method code", () => {
    const r = paymentBreakdown([
      pay("1", 2276, "2026-08-14", "cc"),
      pay("2", 900, "2026-08-15", "cash", { canceled: "2026-08-16 10:00:00" }),
      pay("3", 900, "2026-08-15", "cash", { status: "cancelled" }),
      pay("4", -50, "2026-08-17", "cash"),
    ]);
    expect(r).toEqual({ deposit: 2276, progressPayments: null, paymentMethod: "cc", count: 1 });
  });
  it("is blank with no payments", () => {
    expect(paymentBreakdown([])).toEqual({ deposit: null, progressPayments: null, paymentMethod: null, count: 0 });
    expect(paymentBreakdown(null).count).toBe(0);
  });
});

describe("jobStatus — PAID-IN-FULL yes/no, the PIF date and the completed tick", () => {
  const pay = (date, amount) => ({ id: date, amount, date, method: "cash", methodLabel: "Cash", status: "paid", canceled: false });
  it("says YES (green) when the ledger is settled or the job sits in a Paid stage, dated by the last payment", () => {
    const s = jobStatus({ stage: "Paid New Roof", balanceOwed: 0, totalPayments: 12000, payments: [pay("2026-08-01", 2000), pay("2026-09-10", 10000)] });
    expect(s).toEqual({ paidInFull: true, completed: true, ledgerOwed: false, status: "YES", pifDate: "2026-09-10", tone: "paid" });
    // The "Paid Complete 20xx" and "Paid & Complete" parking stages count too, even without ledger figures.
    expect(jobStatus({ stage: "Paid & Complete 2019-2020", balanceOwed: null, totalPayments: null, payments: [] })).toMatchObject({ paidInFull: true, completed: true, status: "YES", pifDate: null });
    // Paid before the final walk: YES, not yet completed.
    expect(jobStatus({ stage: "Need Final Walk-Through", balanceOwed: 0, totalPayments: 12000, payments: [pay("2026-09-12", 12000)] })).toMatchObject({ paidInFull: true, completed: false, status: "YES", pifDate: "2026-09-12", tone: "paid" });
  });
  it("warns (amber) on a paid stage whose ledger still shows a balance", () => {
    expect(jobStatus({ stage: "Warranty", balanceOwed: 3000, totalPayments: 9000, payments: [pay("2026-08-01", 9000)] }))
      .toEqual({ paidInFull: true, completed: true, ledgerOwed: true, status: PIF_STATUS.mismatch, pifDate: "2026-08-01", tone: "mismatch" });
  });
  it("says NO (red) for everything else that is not cancelled, and ticks completed from the stage", () => {
    expect(jobStatus({ stage: "COMPLETED NEED FINAL PAYMENT!!", balanceOwed: 4000, totalPayments: 8000, payments: [] })).toMatchObject({ completed: true, paidInFull: false, status: "NO", tone: "unpaid" });
    expect(jobStatus({ stage: "Collections", balanceOwed: 4000, totalPayments: 8000, payments: [] })).toMatchObject({ completed: true, status: "NO" });
    // No money received yet: a zero total is not "paid".
    expect(jobStatus({ stage: "Roof/Siding Scheduled", balanceOwed: 0, totalPayments: 0, payments: [] })).toMatchObject({ paidInFull: false, completed: false, status: "NO", tone: "unpaid" });
    expect(jobStatus({ stage: "Production Started", balanceOwed: 8000, totalPayments: 2000, payments: [pay("2026-08-01", 2000)] })).toMatchObject({ status: "NO", pifDate: null });
    // Cancelled: blank, no colour.
    expect(jobStatus({ stage: "Cancel: NO FOLLOW UP(MGR APPR)", balanceOwed: 0, totalPayments: 500, payments: [] })).toEqual({ paidInFull: false, completed: false, ledgerOwed: false, status: null, pifDate: null, tone: null });
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

describe("vendor bills", () => {
  it("classifies the office's vendors by name", () => {
    const v = {
      "New Castle Building Products": "material", "QXO": "material", "Lansing BP Rockaway": "material", "Home Depot": "material",
      "Garfield Lumber & Millworks": "material", "Universal Supply Company": "material",
      "Bin Drop Waste Services": "carting",
      "CAVALLARI CONSTRUCTION CORP": "labor", "Lucy LD Construction Corp.": "labor", "Chuma Siding": "labor",
      "DNC Contracting LLC": "labor", "AK Contractor Enterprises": "labor", "Leaf Solution LLC": "labor",
      "AMK": "other", "": "other",
    };
    for (const [name, cat] of Object.entries(v)) expect([name, classifyVendor(name)]).toEqual([name, cat]);
  });
  it("shortens material vendors to the tab's dropdown names", () => {
    expect(vendorShortName("New Castle Building Products")).toBe("NCBP");
    expect(vendorShortName("Lansing BP Rockaway")).toBe("Lansing");
    expect(vendorShortName("Home Depot")).toBe("Home Depot");
    expect(vendorShortName("Some Roofing Supply")).toBe("Some Roofing Supply");
  });
  it("sums a job's bills by category and names the material vendors in billing order", () => {
    const r = billBreakdown([
      { vendorName: "QXO", category: "material", amount: "1200.50", date: "2026-08-20" },
      { vendorName: "New Castle Building Products", category: "material", amount: 6958.24, date: "2026-08-15" },
      { vendorName: "Bin Drop Waste Services", category: "carting", amount: 550, date: "2026-08-21" },
      { vendorName: "Lucy LD Construction Corp.", category: "labor", amount: 4000, date: "2026-08-25" },
      { vendorName: "New Castle Building Products", category: "material", amount: 100, date: "2026-08-26" },
    ]);
    expect(r).toEqual({
      materialVendor: "NCBP/QXO", containerBilled: true,
      actualMaterial: 8258.74, actualLabor: 4000, actualCarting: 550, actualOther: null, count: 5,
    });
  });
  it("is blank with no bills, and never reports a zero as a cost", () => {
    expect(billBreakdown([])).toEqual({ materialVendor: null, containerBilled: false, actualMaterial: null, actualLabor: null, actualCarting: null, actualOther: null, count: 0 });
    expect(billBreakdown([{ vendorName: "AMK", amount: 900, date: "2026-08-01" }]).actualOther).toBe(900);
  });
});

describe("table and CSV", () => {
  it("puts the label in A, the stage in M, the balance in AB and the job number in AC", () => {
    const [header, first] = sheetTable([row()]);
    expect(header[0]).toBe("Town/Address/Customer");
    expect(header[12]).toBe("Job Stage");
    expect(header[27]).toBe("Balance Owed");
    expect(header[28]).toBe("Job #");
    expect(first[0]).toBe("Paramus/320 Ivy Place/Sam Molano");
    expect(first[10]).toBe("ACR Roofing Division");
    expect(first[12]).toBe("COMPLETED NEED FINAL PAYMENT!!");
    expect(first[15]).toBe("8/28/2026");
    expect(first[17]).toBe("13999.00");
    expect(first[27]).toBe("11723.00");
    expect(first[28]).toBe("2608-9054-01");
    expect(first[30]).toBe("5001");
  });
  it("escapes quotes and keeps one line per job", () => {
    const csv = toSheetCsv([row({ sub: 'Lucy "LC" Construction' })]);
    const lines = csv.split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('"Town/Address/Customer","PAID-IN-FULL"')).toBe(true);
    expect(lines[1]).toContain('"Lucy ""LC"" Construction"');
    expect(lines[1].split('","')).toHaveLength(SHEET_COLUMNS.length + LINK_COLUMNS.length);
  });
  it("is empty-safe", () => {
    expect(sheetTable([])).toHaveLength(1);
    expect(toSheetCsv([]).split("\r\n")).toHaveLength(1);
  });
});
