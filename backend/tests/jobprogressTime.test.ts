import { describe, it, expect } from "vitest";
import { parseApiUtc, officeDateTime, apiTimestampToOffice } from "../src/integrations/jobprogress/time.js";

describe("parseApiUtc", () => {
  it("reads the API's two spellings as UTC", () => {
    expect(parseApiUtc("2026-09-08 21:30:00")?.toISOString()).toBe("2026-09-08T21:30:00.000Z");
    expect(parseApiUtc("2026-09-08T21:30:00")?.toISOString()).toBe("2026-09-08T21:30:00.000Z");
    expect(parseApiUtc("2026-09-08T21:30")?.toISOString()).toBe("2026-09-08T21:30:00.000Z");
  });
  it("honours an explicit offset if one ever appears", () => {
    expect(parseApiUtc("2026-09-08T17:30:00-04:00")?.toISOString()).toBe("2026-09-08T21:30:00.000Z");
    expect(parseApiUtc("2026-09-08T21:30:00Z")?.toISOString()).toBe("2026-09-08T21:30:00.000Z");
  });
  it("rejects anything else", () => {
    expect(parseApiUtc("")).toBeNull();
    expect(parseApiUtc(null)).toBeNull();
    expect(parseApiUtc("09/08/2026 5:30 PM")).toBeNull();
    expect(parseApiUtc("2026-13-40 99:99:00")).toBeNull();
  });
});

describe("officeDateTime / apiTimestampToOffice", () => {
  it("is 4 hours behind UTC in summer (EDT)", () => {
    // The real row that exposed the bug: stored 21:30, a 5:30 PM estimate.
    expect(apiTimestampToOffice("2026-09-08 21:30:00")).toMatchObject({ date: "2026-09-08", time: "17:30" });
    expect(apiTimestampToOffice("2026-09-05 14:00:00")).toMatchObject({ date: "2026-09-05", time: "10:00" });
  });
  it("is 5 hours behind in winter (EST) and moves late evenings back a day", () => {
    expect(apiTimestampToOffice("2026-12-10 00:30:00")).toMatchObject({ date: "2026-12-09", time: "19:30" });
    expect(apiTimestampToOffice("2026-12-10 14:00:00")).toMatchObject({ date: "2026-12-10", time: "09:00" });
  });
  it("keeps midnight as 00, never 24", () => {
    expect(officeDateTime(new Date("2026-07-01T04:00:00Z")).time).toBe("00:00");
  });
  it("returns null for a missing start", () => {
    expect(apiTimestampToOffice(undefined)).toBeNull();
  });
});
