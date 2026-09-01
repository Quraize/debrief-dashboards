import { describe, it, expect } from "vitest";
import {
  getMarketingCategory, isUnmappedSource, isSelfGenNeedsDetail,
  ALL_MARKETING_SOURCES, MARKETING_SOURCE_BY_CATEGORY,
} from "../src/marketingSources.js";

describe("getMarketingCategory", () => {
  it("resolves an exact canonical source", () => {
    expect(getMarketingCategory("Cold Calling")).toBe("Outbound / Rehash");
  });

  it("resolves a historical alias without renaming the raw value", () => {
    expect(getMarketingCategory("Cold Call")).toBe("Outbound / Rehash");
    expect(getMarketingCategory("Angi")).toBe("Lead Aggregators / Purchased Leads");
  });

  it("sends blank and unknown values to cleanup rather than guessing", () => {
    for (const v of ["", "   ", null, undefined, "Something Nobody Mapped"]) {
      expect(getMarketingCategory(v)).toBe("Other / Needs Cleanup");
    }
  });

  it("flags self-gen as needing a subtype", () => {
    expect(isSelfGenNeedsDetail("Self-Gen / Other")).toBe(true);
    expect(isSelfGenNeedsDetail("Cold Calling")).toBe(false);
  });
});

describe("source taxonomy integrity", () => {
  it("every canonical source resolves back to the category that lists it", () => {
    // Stronger than "not uncategorised": sources inside the cleanup category
    // legitimately resolve to it, so assert the exact round-trip instead.
    for (const [category, sources] of Object.entries(MARKETING_SOURCE_BY_CATEGORY)) {
      for (const src of sources) {
        expect(getMarketingCategory(src), `source "${src}"`).toBe(category);
        expect(isUnmappedSource(src), `source "${src}"`).toBe(false);
      }
    }
  });

  it("only the cleanup bucket resolves to Other / Needs Cleanup", () => {
    const cleanup = new Set(MARKETING_SOURCE_BY_CATEGORY["Other / Needs Cleanup"]);
    for (const src of ALL_MARKETING_SOURCES) {
      if (!cleanup.has(src)) expect(getMarketingCategory(src)).not.toBe("Other / Needs Cleanup");
    }
  });

  it("no source is listed under two categories", () => {
    const seen = new Map();
    for (const [cat, sources] of Object.entries(MARKETING_SOURCE_BY_CATEGORY)) {
      for (const s of sources) {
        expect(seen.has(s), `"${s}" appears in both ${seen.get(s)} and ${cat}`).toBe(false);
        seen.set(s, cat);
      }
    }
  });
});
