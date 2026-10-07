/**
 * [AUTOMATION]AP WEEKLY SCORECARD planner: pure rules, no sheets.
 */
import { describe, it, expect } from "vitest";
import {
  planApScorecard, parsePemaTab, completionDay, workingDayEnd, namesJob, liveStartRow, daySerial, type ApJob, type OutRow,
} from "../src/production/apScorecard.js";

const job = (id: string, over: Partial<ApJob> = {}): ApJob => ({
  jobId: id, label: `Town/${id} Main St/Customer ${id}`, stage: "Roof/Siding Scheduled", totalRev: 10000,
  firstInstall: null, lastInstall: null, completed: null, mtc: null, sub: "Lucy Construction", vendor: null,
  materialEst: 3000, laborEst: 2200, billMaterial: null, billLabor: null, billCarting: null, hold: false,
  pifStatus: "NO", completionDate: null, gross: 10000, changeOrders: 0, deposit: 2000, progressPayments: 0, ...over,
});
const TODAY = "2026-10-07"; // Wednesday; current week starts Monday 10/5
const blockOf = (rows: OutRow[], monday: string) => {
  const [y, m, d] = monday.split("-").map(Number);
  const start = rows.findIndex((r) => r.kind === "week" && r.cells[0] === `WEEK OF ${m}/${d}/${y}`);
  const end = rows.findIndex((r, i) => i > start && r.kind === "week");
  return rows.slice(start, end < 0 ? undefined : end);
};
const lines = (block: OutRow[], kind: OutRow["kind"]) => block.filter((r) => r.kind === kind);

describe("dates", () => {
  it("counts MTC in working days, Monday to Saturday, the start being day 1", () => {
    expect(workingDayEnd("2026-10-12", 1)).toBe("2026-10-12");
    expect(workingDayEnd("2026-10-12", 6)).toBe("2026-10-17");   // Mon..Sat
    expect(workingDayEnd("2026-10-12", 7)).toBe("2026-10-19");   // skips Sunday
  });
  it("finishes a job on Date Completed, else the later of its last install day and its MTC end", () => {
    expect(completionDay({ completed: "2026-10-09", firstInstall: "2026-10-01", lastInstall: "2026-10-20", mtc: 30 })).toBe("2026-10-09");
    expect(completionDay({ completed: null, firstInstall: "2026-10-12", lastInstall: "2026-10-12", mtc: 15 })).toBe("2026-10-28");
    expect(completionDay({ completed: null, firstInstall: "2026-10-12", lastInstall: "2026-10-14", mtc: null })).toBe("2026-10-14");
    expect(completionDay({ completed: null, firstInstall: null, lastInstall: null, mtc: 3 })).toBeNull();
  });
});

describe("Danny's hand-typed names", () => {
  it("match a job by surname, allowing small spelling slips", () => {
    expect(namesJob("Roscoe Coleman", "East Orange/197 Hollywood Avenue/Rosco Coleman")).toBe(true);
    expect(namesJob("Marriane Verost", "Township of Washington/535 Bergen Avenue/Marianne Verost")).toBe(true);
    expect(namesJob("Jesus Velasquez", "Paterson/14 Hine Street/Jayson & Jesus Velazquez")).toBe(true);
    expect(namesJob("Karl G", "Nutley/286 Van Winkle Avenue/Karl Giannoglou")).toBe(true); // Danny typed first name + initial
    expect(namesJob("Lisa Diss", "Ridgewood/126 Linden Street/Bill Osullivan")).toBe(false);
  });
});

describe("Pema's tab", () => {
  it("reads each WEEK OF block: section lines, payroll and the single-value rows", () => {
    const grid = [
      ["ALLIED AP + CASH FLOW CONTROL"],
      ["WEEK OF 10/5/2026"],
      ["INSTALL DATE = INVOICE DATE (COGS)", "CLIENT / JOB"],
      ["SUBCONTRACTORS", null, null, 0],
      ["east orange", "Roscoe Coleman", "Lucy", 1630, null, null, null, null, "X", "Ck1372"],
      ["MATERIAL VENDORS", null, null, 0],
      [null, null, "ABC", 2500, "Materials / Supplier AP", "ACT", null, "PAID"],
      [daySerial("2026-10-07"), "Garfield / Ruben Sanchez — MATERIAL", "TBD", 4319.7, "Material Vendor — 30% Planning Estimate", "EST"],
      ["FIXED EXPENSES / DEBT SERVICE", null, null, 0],
      [null, "BOA 6825 — WEEKLY PAYDOWN", "BANK OF AMERICA", 2500],
      ["OPERATING CASH SUBTOTAL", null, null, 0],
      [null, null, "REMOTE PAYROLL", 2050.77],
      [null, null, "ACR PAYROLL", 10000],
      ["WEEKLY CASH NEEDS — ALL UNPAID", null, null, 71517.26],
      ["CASH (POSTED)", null, null, 16392.16],
    ];
    const w = parsePemaTab(grid as never).get("2026-10-05")!;
    expect(w.lines.map((l) => l.section)).toEqual(["SUBCONTRACTORS", "MATERIAL VENDORS", "MATERIAL VENDORS", "FIXED EXPENSES / DEBT SERVICE"]);
    expect(w.values["OP:ACR PAYROLL"]).toBe(10000);
    expect(w.values["WEEKLY CASH NEEDS — ALL UNPAID"]).toBe(71517.26);
    expect(w.values["CASH (POSTED)"]).toBe(16392.16);
  });
});

describe("the automated week blocks", () => {
  const pema = parsePemaTab([
    ["WEEK OF 10/5/2026"],
    ["SUBCONTRACTORS"],
    ["paterson", "Customer Paid", "Lucy", 999, null, null, null, null, "X", "Ck1", "Ck1", "Y"],
    ["MATERIAL VENDORS"],
    [null, null, "ABC", 2500, "Materials / Supplier AP", "ACT", null, "PAID"],
    [daySerial("2026-10-07"), "Old — MATERIAL", "TBD", 4319.7, "Material Vendor — 30% Planning Estimate", "EST"],
    ["FIXED EXPENSES / DEBT SERVICE"],
    [null, "BOA 6825 — WEEKLY PAYDOWN", "BANK OF AMERICA", 2500],
    ["OPERATING CASH SUBTOTAL"],
    [null, null, "ACR PAYROLL", 10000],
    ["WEEKLY CASH NEEDS — ALL UNPAID", null, null, 50000],
  ] as never);

  it("puts material in the install week, the sub the week after completion, and carting at 3.5%", () => {
    const jobs = [
      job("A", { firstInstall: "2026-10-07", lastInstall: "2026-10-07" }),                 // installs and completes week of 10/5
      job("B", { firstInstall: "2026-10-12", lastInstall: "2026-10-12", mtc: 15 }),          // completes 10/28 -> sub due week of 11/2
      job("H", { firstInstall: "2026-10-08", hold: true }),                                  // HOLD: nowhere
    ];
    const plan = planApScorecard({ today: TODAY, jobs, pema, startRow: 5, syncedAt: null });
    const w1 = blockOf(plan.rows, "2026-10-05"), w2 = blockOf(plan.rows, "2026-10-12"), w5 = blockOf(plan.rows, "2026-11-02");
    expect(lines(w1, "mat").map((r) => r.cells[1])).toEqual(["Town/A Main St/Customer A — MATERIAL", null]); // + copied ABC line (no client)
    expect(lines(w1, "mat")[1]!.cells[2]).toBe("ABC");                       // vendor payment copied, ChatGPT's job estimate not copied
    expect(lines(w2, "mat").map((r) => r.cells[1])).toEqual(["Town/B Main St/Customer B — MATERIAL"]);
    expect(lines(w2, "sub").some((r) => String(r.cells[1]).includes("Customer A"))).toBe(true); // A completes 10/7 -> due week of 10/12
    expect(lines(w5, "sub").map((r) => r.cells[1])).toEqual(["Town/B Main St/Customer B — LABOR"]);
    expect(plan.rows.some((r) => String(r.cells[1] ?? "").includes("Customer H"))).toBe(false);
    expect(lines(w2, "cart")[0]!.cells[3]).toBe(350);                         // 3.5% of B's $10,000
    expect(lines(w1, "fix")[0]!.cells[1]).toBe("BOA 6825 — WEEKLY PAYDOWN");
  });

  it("moves a past week's unpaid sub to the current week, and keeps a line Danny marked paid where it was", () => {
    const jobs = [
      job("C", { firstInstall: "2026-09-29", lastInstall: "2026-09-29" }), // done 9/29 -> due week of 10/5 (current): normal line
      job("Paid", { firstInstall: "2026-09-22", lastInstall: "2026-09-22", label: "Paterson/1 St/Customer Paid" }), // due 9/29: before carryFrom
    ];
    const plan = planApScorecard({ today: "2026-10-14", jobs, pema, startRow: 5, syncedAt: null, carryFrom: "2026-10-05" });
    const now = blockOf(plan.rows, "2026-10-12");
    // C was due the week of 10/5, nobody marked it paid there: it is carried into the week of 10/12.
    const carried = lines(now, "sub").find((r) => String(r.cells[1]).includes("Customer C"))!;
    expect(String(carried.cells[12])).toContain("Carried from week of 10/5/2026");
  });

  it("writes subtotals and the cash-needs formula over its own rows, and the comparison with Pema's figure", () => {
    const plan = planApScorecard({ today: TODAY, jobs: [job("A", { firstInstall: "2026-10-07", lastInstall: "2026-10-07" })], pema, startRow: 5, syncedAt: null });
    const w1 = blockOf(plan.rows, "2026-10-05");
    const rowNo = (r: OutRow) => plan.rows.indexOf(r) + 5 + 1;
    const matHead = w1.find((r) => r.kind === "matHead")!, mats = lines(w1, "mat");
    expect(matHead.cells[3]).toEqual({ formula: `SUM(D${rowNo(mats[0]!)}:D${rowNo(mats.at(-1)!)})` });
    const need = w1.find((r) => r.kind === "need")!;
    expect((need.cells[3] as { formula: string }).formula).toContain(`H${rowNo(mats[0]!)}:H${rowNo(mats.at(-1)!)},"<>PAID"`);
    const [pemaRow, diff] = lines(w1, "compare");
    expect(pemaRow!.cells[3]).toBe(50000);
    expect(diff!.cells[3]).toEqual({ formula: `D${rowNo(need)}-D${rowNo(pemaRow!)}` });
    expect(plan.weeks).toHaveLength(5);
    expect(plan.panel[2]!.cells[6]).toEqual({ formula: `D${rowNo(need)}` });
  });
});

describe("what is not copied from Pema's tab, and what counts as paid", () => {
  const pema2 = parsePemaTab([
    ["WEEK OF 10/5/2026"],
    ["SUBCONTRACTORS"],
    ["east orange", "Roscoe Coleman", "Lucy", 1630, null, null, null, null, "X", "Ck1372"],
    [null, "Ridgewood / Bill O'Sullivan — LABOR", "Cesar Chuma", 3453.78, "Subcontractor — 22% Planning Estimate", "EST"],
    ["FIXED EXPENSES / DEBT SERVICE"],
    [null, "PRIOR-WEEK SUBCONTRACTOR CATCH-UP — CASH ONLY", "9/21 + 9/28 SUBS", 25280],
    [null, "BOA 6825 — WEEKLY PAYDOWN", "BANK OF AMERICA", 2500],
    ["WEEK OF 10/12/2026"],
    ["SUBCONTRACTORS"],
  ] as never);
  it("skips ChatGPT's planning-estimate lines and the catch-up lump, keeps Danny's check line as paid, and does not add the job again a week later", () => {
    const coleman = job("RC", { label: "East Orange/197 Hollywood Avenue/Rosco Coleman", firstInstall: "2026-10-06", lastInstall: "2026-10-07", billLabor: 1630 });
    const plan = planApScorecard({ today: TODAY, jobs: [coleman], pema: pema2, startRow: 5, syncedAt: null });
    const w1 = blockOf(plan.rows, "2026-10-05"), w2 = blockOf(plan.rows, "2026-10-12");
    expect(lines(w1, "sub").map((r) => r.cells[1])).toEqual(["Roscoe Coleman"]);            // Danny's line copied, ChatGPT's estimate not
    expect(lines(w1, "fix").map((r) => r.cells[1])).toEqual(["BOA 6825 — WEEKLY PAYDOWN"]);  // no catch-up lump
    expect(lines(w2, "sub")).toHaveLength(0);                                                 // already paid by Danny on 10/5
    expect(plan.weeks[0]!.subs).toBe(0);                                                      // a check number = paid, not cash still needed
  });
});

describe("the live area", () => {
  it("starts at the current week's block, or below the frozen weeks, or under the panel on a new tab", () => {
    expect(liveStartRow([], TODAY)).toBe(5);
    const tab = [["title"], [], [], [], [], ["WEEK OF 9/28/2026"], ["x"], [], ["WEEK OF 10/5/2026"], ["y"]];
    expect(liveStartRow(tab as never, TODAY)).toBe(8);
    expect(liveStartRow(tab.slice(0, 7) as never, TODAY)).toBe(8);
  });
});
