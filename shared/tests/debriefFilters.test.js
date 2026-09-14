import { describe, it, expect } from "vitest";
import {
  applyDebriefFilters, debriefFilterOptions, debriefHasRep, debriefTrades,
  activeFilterCount, describeFilters, EMPTY_DEBRIEF_FILTERS,
} from "../src/debriefFilters.js";

const d = (over) => ({
  sales_rep: "Jason Malarchak", appointment_setter: "Ashley Pascual",
  appointment_type: "First Appointment", marketing_source: "Angi", trade: "Roofing", ...over,
});

const ROWS = [
  d({}),
  d({ sales_rep: "Dave Marrero", appointment_setter: "Rachel Ortiz", appointment_type: "Rehash", marketing_source: "Self-Gen", trade: "Roofing, Siding" }),
  d({ sales_rep: "Dave Marrero", secondary_sales_rep: "Jason Malarchak", appointment_type: "Re-Engagement", trade: "Siding" }),
  d({ marketing_source: "", trade: "" }),
];

describe("applyDebriefFilters", () => {
  it("returns everything when nothing is set", () => {
    expect(applyDebriefFilters(ROWS, EMPTY_DEBRIEF_FILTERS)).toHaveLength(4);
    expect(applyDebriefFilters(ROWS, undefined)).toHaveLength(4);
  });

  it("credits a rep their split sales, not just the ones they own outright", () => {
    const mine = applyDebriefFilters(ROWS, { rep: "Jason Malarchak" });
    expect(mine).toHaveLength(3); // two owned + one where he is the secondary rep
    expect(debriefHasRep({ sales_rep: "A", secondary_sales_rep: "B" }, "b")).toBe(true);
    expect(debriefHasRep({ sales_rep: "A" }, "B")).toBe(false);
  });

  it("matches appointment types through their legacy spellings", () => {
    // "Re-Engagement" is the old label for Rehash and must filter with it.
    expect(applyDebriefFilters(ROWS, { apptType: "Rehash" })).toHaveLength(2);
    expect(applyDebriefFilters(ROWS, { apptType: "First Appointment" })).toHaveLength(2);
  });

  it("matches one trade inside a multi-trade debrief", () => {
    expect(debriefTrades({ trade: "Roofing, Siding" })).toEqual(["Roofing", "Siding"]);
    expect(applyDebriefFilters(ROWS, { trade: "Siding" })).toHaveLength(2);
    expect(applyDebriefFilters(ROWS, { trade: "Roofing" })).toHaveLength(2);
  });

  it("filters by source and by the category a source rolls up to", () => {
    expect(applyDebriefFilters(ROWS, { source: "Angi" })).toHaveLength(2);
    const selfGen = applyDebriefFilters(ROWS, { mktCategory: "Self-Generated / Needs Detail" });
    expect(selfGen).toHaveLength(1);
    expect(selfGen[0].marketing_source).toBe("Self-Gen");
  });

  it("stacks filters", () => {
    expect(applyDebriefFilters(ROWS, { rep: "Dave Marrero", apptType: "Rehash" })).toHaveLength(2);
    expect(applyDebriefFilters(ROWS, { rep: "Dave Marrero", apptType: "Rehash", trade: "Siding" })).toHaveLength(2);
    expect(applyDebriefFilters(ROWS, { rep: "Dave Marrero", setter: "Ashley Pascual", apptType: "Rehash" })).toHaveLength(1);
  });
});

describe("debriefFilterOptions", () => {
  it("offers only values present in the data, secondary reps included, Unassigned last", () => {
    const o = debriefFilterOptions(ROWS);
    expect(o.reps).toEqual(["Dave Marrero", "Jason Malarchak"]);
    expect(o.setters).toEqual(["Ashley Pascual", "Rachel Ortiz"]);
    expect(o.apptTypes).toEqual(["First Appointment", "Rehash"]); // normalised, de-duplicated
    expect(o.trades).toEqual(["Roofing", "Siding"]);
    expect(o.sources.at(-1)).toBe("Unassigned"); // the blank source lands in the cleanup bucket
    expect(o.sources).toContain("Angi");
  });

  it("survives an empty list", () => {
    expect(debriefFilterOptions([])).toEqual({ reps: [], setters: [], apptTypes: [], sources: [], trades: [] });
  });
});

describe("what is selected", () => {
  it("counts and describes the active filters in display order", () => {
    const f = { trade: "Siding", rep: "Jason Malarchak" };
    expect(activeFilterCount(f)).toBe(2);
    expect(activeFilterCount(EMPTY_DEBRIEF_FILTERS)).toBe(0);
    expect(describeFilters(f)).toEqual([
      { key: "rep", label: "Sales Rep", value: "Jason Malarchak" },
      { key: "trade", label: "Trade", value: "Siding" },
    ]);
  });
});
