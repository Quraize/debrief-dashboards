import { describe, it, expect } from "vitest";
import { STAGE_GROUPS, stageGroup, isTrackedStage, stageOrder, daysInStage, isPaidStage, isCompletedStage } from "../src/jobStages.js";

describe("done and paid stages", () => {
  it("reads the office's Paid stages, whatever the year", () => {
    for (const s of ["Paid New Roof", "Paid Siding/Repair/MISC/ETC", "Paid Repair/Remodel", "Paid Complete 2026", "Paid & Complete 2019-2020", "Paid Don't Contact", "Warranty", "Client Satisfaction/Referrals", "Closed Warranty Claims", "12-Month Touch Point"]) {
      expect(isPaidStage(s), s).toBe(true);
      expect(isCompletedStage(s), s).toBe(true);
    }
  });
  it("knows finished-but-unpaid, and leaves working and lost jobs alone", () => {
    for (const s of ["COMPLETED NEED FINAL PAYMENT!!", "Collections", "Open Warranty Claims/CallBacks"]) {
      expect(isCompletedStage(s), s).toBe(true);
      expect(isPaidStage(s), s).toBe(false);
    }
    for (const s of ["Production Started", "Need Final Walk-Through", "Job Lost DNS (MGR APPROVAL)", "Accepted/No Deposit/Finance", null, ""]) {
      expect(isCompletedStage(s), String(s)).toBe(false);
      expect(isPaidStage(s), String(s)).toBe(false);
    }
  });
});

describe("stage groups — the office's Jobs screen grouping", () => {
  it("places the live stage names (as the API spells them) in the right group", () => {
    expect(stageGroup("Production Started")?.key).toBe("production");
    expect(stageGroup("COMPLETED NEED FINAL PAYMENT!!")?.key).toBe("production");
    expect(stageGroup("Install Accepted-> SUBMIT SS")?.key).toBe("project_won");
    expect(stageGroup("On Hold/Credit DQ (MGR APPR)")?.key).toBe("project_won");
    expect(stageGroup("Open Warranty Claims/CallBacks")?.key).toBe("warranty");
  });

  it("tolerates spacing and case differences, and leaves sales-pipeline stages untracked", () => {
    expect(stageGroup("production   started")?.key).toBe("production");
    expect(isTrackedStage("LEAD NOT CONTACTED!!!")).toBe(false);
    expect(isTrackedStage("Demo No Sale")).toBe(false);
    expect(isTrackedStage("Paid New Roof")).toBe(false);
    expect(isTrackedStage(null)).toBe(false);
  });

  it("orders stages as JobProgress lists them", () => {
    expect(stageOrder("Production Review")).toBeLessThan(stageOrder("Production Started"));
    expect(stageOrder("Sales Review")).toBeLessThan(stageOrder("Production Review"));
    expect(stageOrder("Unknown")).toBe(999);
    expect(STAGE_GROUPS.map((g) => g.label)).toEqual(["Project Won", "Production", "Warranty Work"]);
  });

  it("computes whole days in stage", () => {
    const now = new Date("2026-09-05T12:00:00Z");
    expect(daysInStage("2026-09-04 20:50:46", now)).toBe(0);
    expect(daysInStage("2026-08-20T00:00:00Z", now)).toBe(16);
    expect(daysInStage(null, now)).toBeNull();
  });
});
