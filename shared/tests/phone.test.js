import { describe, it, expect } from "vitest";
import { phoneKey, formatPhone, phoneKeys } from "../src/phone.js";

describe("phoneKey", () => {
  it("reduces every spelling of a US number to the same ten digits", () => {
    for (const raw of ["(201) 555-0134", "201.555.0134", "201-555-0134", "+1 201 555 0134", "12015550134", "2015550134", " 201 555 0134 x22", "201-555-0134 ext. 3"]) {
      expect(phoneKey(raw)).toBe("2015550134");
    }
  });
  it("rejects what is not a North American number", () => {
    expect(phoneKey("555-0134")).toBeNull();          // seven digits
    expect(phoneKey("+44 20 7946 0958")).toBeNull();  // UK
    expect(phoneKey("0015550134")).toBeNull();        // area code cannot start with 0
    expect(phoneKey("2011550134")).toBeNull();        // exchange cannot start with 1
    expect(phoneKey("")).toBeNull();
    expect(phoneKey(null)).toBeNull();
    expect(phoneKey("call me")).toBeNull();
  });
});

describe("formatPhone / phoneKeys", () => {
  it("formats a key and echoes anything else", () => {
    expect(formatPhone("+12015550134")).toBe("(201) 555-0134");
    expect(formatPhone("n/a")).toBe("n/a");
  });
  it("de-duplicates across spellings, keeping first-seen order", () => {
    expect(phoneKeys(["201-555-0134", "(201) 555-0134", "973 555 0100", null, "bad"])).toEqual(["2015550134", "9735550100"]);
  });
});
