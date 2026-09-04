import { describe, it, expect } from "vitest";
import { STAGE_GROUPS, stageGroup, isTrackedStage, stageOrder, daysInStage } from "../src/jobStages.js";

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
