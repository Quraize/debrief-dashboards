import { describe, it, expect } from "vitest";
import { parseScheduleTitle, scheduleStatus, jobTypeColor, DEFAULT_TYPE_COLOR, splitAtMonthEnd, sheetWeekOf, sheetWeekFrom } from "../src/production.js";

describe("sheetWeekFrom", () => {
  const S = "2026-08-31";
  it("steps through the sheet's blocks, halves included", () => {
    expect(sheetWeekFrom("2026-09-29", 0, S)).toEqual({ from: "2026-09-28", to: "2026-09-30" });
    expect(sheetWeekFrom("2026-09-29", 1, S)).toEqual({ from: "2026-10-01", to: "2026-10-04" });
    expect(sheetWeekFrom("2026-09-29", -1, S)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(sheetWeekFrom("2026-10-01", 0, S)).toEqual({ from: "2026-10-01", to: "2026-10-04" });
    expect(sheetWeekFrom("2026-10-01", -1, S)).toEqual({ from: "2026-09-28", to: "2026-09-30" });
    expect(sheetWeekFrom("2026-10-01", 1, S)).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  });
});

describe("sheetWeekOf", () => {
  it("names the sheet block a day is in: its Monday week, cut at the month end once splitting applies", () => {
    expect(sheetWeekOf("2026-09-30", "2026-08-31")).toEqual({ from: "2026-09-28", to: "2026-09-30" });
    expect(sheetWeekOf("2026-10-02", "2026-08-31")).toEqual({ from: "2026-10-01", to: "2026-10-04" });
    expect(sheetWeekOf("2026-09-03", "2026-08-31")).toEqual({ from: "2026-09-01", to: "2026-09-06" });
    expect(sheetWeekOf("2026-09-16", "2026-08-31")).toEqual({ from: "2026-09-14", to: "2026-09-20" });
    // Before the cut-over a month-crossing week stays whole.
    expect(sheetWeekOf("2026-09-03", "2026-09-28")).toEqual({ from: "2026-08-31", to: "2026-09-06" });
  });
});

describe("parseScheduleTitle — the office's title convention", () => {
  // Every title below was observed verbatim on the September 2026 production calendar.
  it("parses code / town / address / customer", () => {
    expect(parseScheduleTitle("RR: Randolph/6 Meadow Lark Court/RR/Joseph Lorent")).toMatchObject({
      code: "RR", label: "Roof Replacement", town: "Randolph", address: "6 Meadow Lark Court", customer: "Joseph Lorent",
    });
  });

  it("ignores a repeated code segment that is not the job's own code", () => {
    expect(parseScheduleTitle("GUTTERS: West Orange/29 Carter Rd/SR/George Golab")).toMatchObject({
      code: "GUTTERS", label: "Gutters", town: "West Orange", address: "29 Carter Rd", customer: "George Golab",
    });
  });

  it("handles combined and multi-word codes", () => {
    expect(parseScheduleTitle("RR+SR: Saddle Brook/43 Bella Vista Avenue/MGC/Miguel Fernandez ").code).toBe("RR+SR");
    expect(parseScheduleTitle("MS REPAIR: Roseland/14 Camlet Court/Ester Ivanyutin")).toMatchObject({
      code: "MS REPAIR", label: "Misc Repair", town: "Roseland", customer: "Ester Ivanyutin",
    });
    expect(parseScheduleTitle("MS-CB: Boonton/209 Chestnut St/RR/Keith Janes").label).toBe("Callback");
  });

  it("tolerates loose spacing and the customer-first variant", () => {
    expect(parseScheduleTitle("WR: Rochelle Park/ 24 Lexington Avenue  / Unni Marcazo")).toMatchObject({
      town: "Rochelle Park", address: "24 Lexington Avenue", customer: "Unni Marcazo",
    });
    expect(parseScheduleTitle("SHED: Janet Dixon / Job # 2025-100618")).toMatchObject({
      code: "SHED", town: "Janet Dixon", address: "Job # 2025-100618",
    });
  });

  it("never throws on titles outside the convention", () => {
    expect(parseScheduleTitle("Pick up materials")).toMatchObject({ code: null, label: "Other", customer: "Pick up materials" });
    expect(parseScheduleTitle("")).toMatchObject({ code: null, label: "Unknown" });
    expect(parseScheduleTitle(null).summary).toBe("");
  });
});

describe("scheduleStatus", () => {
  it("is completed, else assigned when a crew exists, else unassigned", () => {
    expect(scheduleStatus({ is_completed: true, crews: ["Luis"] })).toBe("completed");
    expect(scheduleStatus({ is_completed: false, crews: ["Luis"] })).toBe("assigned");
    expect(scheduleStatus({ is_completed: false, crews: [] })).toBe("unassigned");
    expect(scheduleStatus({ isCompleted: false })).toBe("unassigned");
  });
});

describe("jobTypeColor", () => {
  it("gives known codes a stable colour and unknown ones the default", () => {
    expect(jobTypeColor("RR")).not.toBe(DEFAULT_TYPE_COLOR);
    expect(jobTypeColor("RR")).toBe(jobTypeColor("RR"));
    expect(jobTypeColor("ZZZ")).toBe(DEFAULT_TYPE_COLOR);
    expect(jobTypeColor(null)).toBe(DEFAULT_TYPE_COLOR);
  });
});

describe("splitAtMonthEnd", () => {
  it("cuts a week that crosses a month end, and leaves the rest alone", () => {
    expect(splitAtMonthEnd({ from: "2026-09-28", to: "2026-10-04" })).toEqual([{ from: "2026-09-28", to: "2026-09-30" }, { from: "2026-10-01", to: "2026-10-04" }]);
    expect(splitAtMonthEnd({ from: "2026-09-21", to: "2026-09-27" })).toEqual([{ from: "2026-09-21", to: "2026-09-27" }]);
    expect(splitAtMonthEnd({ from: "2026-12-28", to: "2027-01-03" })).toEqual([{ from: "2026-12-28", to: "2026-12-31" }, { from: "2027-01-01", to: "2027-01-03" }]);
    expect(splitAtMonthEnd({ from: "2027-02-22", to: "2027-02-28" })).toEqual([{ from: "2027-02-22", to: "2027-02-28" }]);   // February ends on a Sunday
    expect(splitAtMonthEnd({ from: "2028-02-28", to: "2028-03-05" })).toEqual([{ from: "2028-02-28", to: "2028-02-29" }, { from: "2028-03-01", to: "2028-03-05" }]); // leap year
  });
});
