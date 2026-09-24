/**
 * The Production KPIs dashboard: its data tab built from the weekly tab as the
 * push leaves it, and the dashboard's layout. Pure — no database, no Google.
 */
import { describe, it, expect } from "vitest";
import { dashboardData, dataTabRequests, dashboardLayoutRequests, monthLabel, ALL_WEEKS, type PaymentRow } from "../src/production/dashboardSheet.js";
import { colIndex, CUMULATIVE_LABEL } from "../src/production/sheetPlan.js";
import type { SheetRow } from "../src/production/weeklyJobSheet.js";

const HU = colIndex("HU"), HY = colIndex("HY");
const STALE = "Not on the JobProgress calendar this week";
const job = (id: string, over: Partial<SheetRow> = {}): SheetRow => ({
  jobId: id, customerId: "c", jobNumber: `2609-${id}-01`, jobName: null, customer: `Customer ${id}`, address: null, city: null, label: `Wayne/${id}`,
  division: null, trades: null, insurance: false, stage: "Production Started", stageGroup: "production", stageSince: null, salesRep: null, sub: null,
  scheduledInstallDate: null, saleDate: "2026-08-01", completionDate: null, installDates: [], nextInstallDate: null, visits: [],
  gross: 10000, changeOrders: 0, totalRev: 10000, paymentMethod: null, deposit: 2000, progressPayments: 3000, paymentsCount: 2, totalPayments: 5000, balanceOwed: 5000,
  pifStatus: "NO", pifDate: null, jobComplete: false, paidInFull: false, statusTone: "unpaid",
  subScheduled: false, materialVendor: null, containerScheduled: false, actualMaterial: null, actualLabor: null, actualCarting: null, actualOther: null,
  billsCount: 0, bills: [], financialsFetchedAt: null, paymentsFetchedAt: null, billsFetchedAt: null, jpUrl: null,
  ...over,
} as SheetRow);
const jobRow = (id: string, status = "Synced from JobProgress") => { const r: (string | number | null)[] = []; r[0] = `Wayne/${id}`; r[HU] = id; r[HY] = status; return r; };

describe("dashboardData", () => {
  // Two September weeks and one October week; job 1 spans both September weeks.
  const grid = [
    ["Town/Address/Customer"],
    ["10/1/2026-10/4/2026"], jobRow("3"), ["Weekly Total"], [CUMULATIVE_LABEL], [],
    ["9/14/2026-9/20/2026"], jobRow("1"), jobRow("2"), jobRow("9", STALE), ["Weekly Total"], [CUMULATIVE_LABEL], [],
    ["9/7/2026-9/13/2026"], jobRow("1"), ["Weekly Total"], [CUMULATIVE_LABEL],
  ];
  const feed = [
    job("1"), job("2", { totalRev: 30000, gross: 30000, balanceOwed: 0, totalPayments: 30000, pifStatus: "YES" }), job("3"), job("9"),
    job("4", { stage: "COMPLETED NEED FINAL PAYMENT!!", completionDate: "2026-08-01", balanceOwed: 1500, totalPayments: 0 }),   // overdue, not on the tab
  ];
  const payments: PaymentRow[] = [
    { date: "2026-09-15", amount: 5000, method: "Check", jobId: "1", jobNumber: null, customer: "Customer 1" },
    { date: "2026-10-02", amount: 700, method: "Card", jobId: "3", jobNumber: null, customer: "Customer 3" },
  ];
  const d = dashboardData(grid as never, feed, payments, "2026-09-24", 30);

  it("holds one row per job per week as the tab does, stale rows out, first row per month marked", () => {
    const rows = d.jobs.map((r) => [r[2], r[4], r[14]]);
    expect(rows).toEqual([
      ["9/7/2026-9/13/2026", "1", 1],
      ["9/14/2026-9/20/2026", "1", 0],     // job 1 again in September: counted once in the month view
      ["9/14/2026-9/20/2026", "2", 1],
      ["10/1/2026-10/4/2026", "3", 1],
    ]);
    expect(d.jobs[2]!.slice(3, 14)).toEqual(["September 2026", "2", "2609-2-01", "Customer 2", 30000, 30000, 2000, 3000, 30000, 0, "YES"]);
    expect(d.counts).toEqual({ jobRows: 4, payments: 2, weeks: 3 });
  });

  it("lists weeks newest first and every month with data, newest first, and the overdue balance from the whole feed", () => {
    expect(d.weeks.map((w) => [w[0], w[3]])).toEqual([["10/1/2026-10/4/2026", "October 2026"], ["9/14/2026-9/20/2026", "September 2026"], ["9/7/2026-9/13/2026", "September 2026"]]);
    expect(d.months.map((m) => m[0])).toEqual(["October 2026", "September 2026"]);
    expect(d.overdue).toBe(1500);
    expect(d.payments[0]!.slice(1)).toEqual(["October 2026", "3", "Customer 3", 700, "Card"]);
    expect(monthLabel("2026-12-31")).toBe("December 2026");
  });

  it("writes the data tab: clears the value area first, then values, then the formula areas that follow the dashboard's Month", () => {
    const reqs = dataTabRequests(77, d, "[AUTOMATION] Production KPIs DASHBOARD") as Record<string, Record<string, unknown>>[];
    expect(reqs[0]!["updateCells"]).toMatchObject({ range: { sheetId: 77, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: colIndex("AF") + 1 }, fields: "userEnteredValue" });
    const text = JSON.stringify(reqs);
    expect(text).toContain(`={\\"${ALL_WEEKS}\\";IFERROR(FILTER($Y$2:$Y,$AB$2:$AB='[AUTOMATION] Production KPIs DASHBOARD'!$B$4)`);
    expect(text).toContain("Overdue Balance (today)");
    expect(text).toContain('"numberValue":1500');
  });
});

describe("dashboardLayoutRequests", () => {
  const reqs = dashboardLayoutRequests(5, 7, "[AUTOMATION] Dashboard Data", "2026-09-24") as Record<string, unknown>[];
  const text = JSON.stringify(reqs);

  it("lays out the filters on the current month and All weeks, with dropdowns from the data tab", () => {
    expect(text).toContain('"stringValue":"September 2026"');
    expect(text).toContain(`"stringValue":"${ALL_WEEKS}"`);
    const dv = reqs.filter((r) => r["setDataValidation"]).map((r) => JSON.stringify(r));
    expect(dv).toHaveLength(2);
    expect(dv[0]).toContain("'[AUTOMATION] Dashboard Data'!$AD$2:$AD$200");
    expect(dv[1]).toContain("'[AUTOMATION] Dashboard Data'!$AH$2:$AH$30");
  });

  it("makes every card a formula that switches between the month (first row per job) and the one week", () => {
    for (const card of ["Gross $", "Total Revenue", "Deposits", "Progress Payments", "Total Received", "Balance Owed", "Collected in Period", "Paid in Full (jobs)", "Not Paid in Full (jobs)", "Overdue Balance (today, 30+ days)"]) expect(text).toContain(card);
    expect(text).toContain(`=IF($E$4=\\"${ALL_WEEKS}\\",SUMIFS('[AUTOMATION] Dashboard Data'!$H:$H,'[AUTOMATION] Dashboard Data'!$D:$D,$B$4,'[AUTOMATION] Dashboard Data'!$O:$O,1),SUMIFS('[AUTOMATION] Dashboard Data'!$H:$H,'[AUTOMATION] Dashboard Data'!$C:$C,$E$4))`);
    // Collected reads payment dates, not job rows.
    expect(text).toContain("SUMIFS('[AUTOMATION] Dashboard Data'!$V:$V,'[AUTOMATION] Dashboard Data'!$R:$R,\\\">=\\\"&VLOOKUP($E$4");
  });

  it("adds the three charts, and every text it writes is black", () => {
    const charts = reqs.filter((r) => r["addChart"]).map((r) => JSON.stringify(r));
    expect(charts).toHaveLength(3);
    expect(charts[0]).toContain("Total Revenue vs Collected"); expect(charts[1]).toContain("Balance Owed"); expect(charts[2]).toContain("pieChart");
    const colours = [...text.matchAll(/"foregroundColor":\{"red":([\d.]+),"green":([\d.]+),"blue":([\d.]+)\}/g)].map((m) => m.slice(1).join(","));
    expect(colours.length).toBeGreaterThan(0);
    expect(new Set(colours)).toEqual(new Set(["0,0,0"]));
  });
});
