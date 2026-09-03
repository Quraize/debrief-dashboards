import { describe, it, expect } from "vitest";
import { parseScheduleTitle, scheduleStatus, jobTypeColor, DEFAULT_TYPE_COLOR } from "../src/production.js";

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
