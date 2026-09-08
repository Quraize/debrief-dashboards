import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { inDateRange, getDateRangeBounds, QUEUE_DATE_FILTERS, DATE_FILTERS, ALL_TIME_FILTER } from "../src/constants.js";

// Tuesday 2026-09-08. This week = Mon 09-07 → Sun 09-13; last week = Mon 08-31 → Sun 09-06.
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-08T10:00:00")); });
afterAll(() => vi.useRealTimers());

describe("Last Week", () => {
  it("is the previous Monday-to-Sunday week", () => {
    expect(getDateRangeBounds("Last Week")).toEqual({ start: "2026-08-31", end: "2026-09-06" });
    expect(inDateRange("2026-08-31", "Last Week")).toBe(true);
    expect(inDateRange("2026-09-06", "Last Week")).toBe(true);
    expect(inDateRange("2026-08-30", "Last Week")).toBe(false);
    expect(inDateRange("2026-09-07", "Last Week")).toBe(false);
  });
});

describe("Last 7 Days", () => {
  it("is today and the six days before it", () => {
    expect(getDateRangeBounds("Last 7 Days")).toEqual({ start: "2026-09-02", end: "2026-09-08" });
    expect(inDateRange("2026-09-02", "Last 7 Days")).toBe(true);
    expect(inDateRange("2026-09-08", "Last 7 Days")).toBe(true);
    expect(inDateRange("2026-09-01", "Last 7 Days")).toBe(false);
    expect(inDateRange("2026-09-09", "Last 7 Days")).toBe(false);
  });
});

describe("All Time", () => {
  it("matches every dated row and has no bounds", () => {
    expect(inDateRange("2019-01-01", ALL_TIME_FILTER)).toBe(true);
    expect(inDateRange("", ALL_TIME_FILTER)).toBe(false);
    expect(getDateRangeBounds(ALL_TIME_FILTER)).toBeNull();
  });
});

describe("filter lists", () => {
  it("keeps the dashboards' list unchanged and gives the queue its own", () => {
    expect(DATE_FILTERS).not.toContain("Last Week");
    expect(QUEUE_DATE_FILTERS[0]).toBe(ALL_TIME_FILTER);
    for (const f of QUEUE_DATE_FILTERS) if (f !== ALL_TIME_FILTER && f !== "Custom Range") expect(getDateRangeBounds(f)?.start).toBeTruthy();
  });
});
