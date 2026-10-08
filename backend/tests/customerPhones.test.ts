/**
 * Customer phones from the JobProgress payload: the wrapped { data: [...] }
 * relation (what the API sends) and a plain array both read.
 */
import { describe, it, expect } from "vitest";
import { customerPhones } from "../src/jobs/syncCustomers.js";

describe("customerPhones", () => {
  it("reads JobProgress's wrapped phones relation (it was read as empty before)", () => {
    const api = { phones: { data: [{ label: "cell", number: "(973) 555-0142" }, { label: "home", number: "973-555-0142" }, { label: "work", number: "201.555.0199" }] } };
    expect(customerPhones(api)).toEqual([
      { key: "9735550142", label: "cell", raw: "(973) 555-0142" },
      { key: "2015550199", label: "work", raw: "201.555.0199" },
    ]);
  });
  it("still reads a plain array, and drops numbers that cannot be a US ten-digit number", () => {
    expect(customerPhones({ phones: [{ label: "cell", number: "+1 973 555 0142" }, { label: "x", number: "12" }] }).map((p) => p.key)).toEqual(["9735550142"]);
    expect(customerPhones({})).toEqual([]);
  });
});
