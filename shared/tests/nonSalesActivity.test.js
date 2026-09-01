/**
 * The consolidated non-sales definition.
 *
 * Replaces classification-drift.test.js, which existed to pin the divergence
 * between four copies of these keywords while it still existed. That file was
 * written to fail the moment they were unified; this is what it was replaced by.
 *
 * What matters here is not that the rules are "correct" in the abstract — they
 * encode a business judgement about what counts as a sales opportunity — but
 * that there is exactly ONE of them, and that every consumer agrees.
 */
import { describe, it, expect } from "vitest";
import {
  NON_SALES_KEYWORDS, isNonSalesTitle, nonSalesKeyword,
} from "../src/nonSalesActivity.js";
import { classifySalesAppointment } from "../src/salesAppointment.js";
import { classifyAppointment } from "../src/appointmentClassification.js";

describe("the keyword list itself", () => {
  it("has no duplicates", () => {
    expect(new Set(NON_SALES_KEYWORDS).size).toBe(NON_SALES_KEYWORDS.length);
  });

  it("is stored normalised, so matching cannot miss on case or spacing", () => {
    for (const k of NON_SALES_KEYWORDS) {
      expect(k, `"${k}" should be lowercase`).toBe(k.toLowerCase());
      expect(k.trim(), `"${k}" should not be padded`).toBe(k);
      expect(k, `"${k}" should not contain double spaces`).not.toMatch(/\s{2,}/);
    }
  });

  it("contains no entry made redundant by another", () => {
    // Matching is substring-based, so "warranty callback" would be dead weight
    // next to "warranty". Redundant entries are not harmful, but they imply a
    // distinction the code does not actually make.
    for (const a of NON_SALES_KEYWORDS) {
      for (const b of NON_SALES_KEYWORDS) {
        if (a !== b) {
          expect(a.includes(b), `"${a}" is redundant — "${b}" already matches it`).toBe(false);
        }
      }
    }
  });
});

describe("isNonSalesTitle", () => {
  it.each(NON_SALES_KEYWORDS)("matches a title containing %s", (keyword) => {
    expect(isNonSalesTitle(`ROOF ${keyword.toUpperCase()} EST`)).toBe(true);
  });

  it("normalises case and internal whitespace before matching", () => {
    expect(isNonSalesTitle("ROOF   INSPECTION   EST")).toBe(true);
    expect(isNonSalesTitle("  customer   service  ")).toBe(true);
  });

  it("leaves a genuine sales title alone", () => {
    for (const t of ["ROOF EST", "SIDING EST", "REHASH ROOF EST", "NO SEE ROOF EST"]) {
      expect(isNonSalesTitle(t), t).toBe(false);
    }
  });

  it("does not treat a blank title as non-sales", () => {
    // Callers decide what an absent title means; the two consumers differ, and
    // that decision does not belong in the keyword matcher.
    for (const blank of ["", "   ", null, undefined]) {
      expect(isNonSalesTitle(blank)).toBe(false);
    }
  });

  it("reports which keyword caused the exclusion", () => {
    expect(nonSalesKeyword("ROOF INSPECTION EST")).toBe("inspection");
    expect(nonSalesKeyword("ROOF EST")).toBeNull();
  });
});

describe("every consumer now agrees", () => {
  // The regression this whole sprint exists to prevent. Before consolidation
  // these two disagreed on 13 of 19 keywords: `ROOF INSPECTION EST` was a sales
  // appointment to one and Non-Sales to the other, so the same record was
  // counted differently depending on which screen you looked at.
  it.each(NON_SALES_KEYWORDS)(
    "'%s' is non-sales to BOTH classifiers", (keyword) => {
      const title = `ROOF ${keyword.toUpperCase()} EST`;
      expect(classifySalesAppointment(title).isSales,
        `classifySalesAppointment should reject "${title}"`).toBe(false);
      expect(classifyAppointment({ title }).reporting_division,
        `classifyAppointment should bucket "${title}" as Non-Sales`).toBe("Non-Sales");
    });

  it.each([
    ["ROOF EST", "Roofing"],
    ["SIDING EST", "Siding"],
    ["ROOF & SIDING EST", "Roofing + Siding"],
    ["REPAIR EST", "Repairs"],
  ])("'%s' is a sales appointment to both, bucketed as %s", (title, division) => {
    expect(classifySalesAppointment(title).isSales).toBe(true);
    expect(classifyAppointment({ title }).reporting_division).toBe(division);
  });

  it("keeps the EST token rule intact after consolidation", () => {
    // \best\b must not match inside "estimating" — there is no word boundary
    // after "est". This survived the refactor.
    expect(classifySalesAppointment("ESTIMATING IN PROGRESS").isSales).toBe(false);
    expect(classifySalesAppointment("ROOF EST").isSales).toBe(true);
  });

  it("still explains why a record was excluded", () => {
    const r = classifySalesAppointment("Warranty Callback");
    expect(r.isSales).toBe(false);
    expect(r.reason).toMatch(/^Excluded — /);
  });
});

describe("known-tricky real-world titles", () => {
  // These are the cases the four divergent lists actually disagreed on.
  it.each([
    ["ROOF INSPECTION EST", false],
    ["SIDING MEASURE EST", false],
    ["ROOF INSTALL EST", false],
    ["ROOF PRODUCTION EST", false],
    ["ROOF COLLECTION EST", false],
    ["WARRANTY EST", false],
    ["WARRANTY CALLBACK", false],
    ["MATERIAL DELIVERY", false],
    ["UNASSIGNED", false],
    ["ROOF EST", true],
    ["MISC EST", true],
    ["REHASH ROOF EST", true],
  ])("%s -> sales appointment: %s", (title, expected) => {
    expect(classifySalesAppointment(title).isSales).toBe(expected);
  });
});
