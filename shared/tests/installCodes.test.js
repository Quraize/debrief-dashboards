import { describe, it, expect } from "vitest";
import { INSTALL_CODES, isInstallCode } from "../src/production.js";

describe("isInstallCode — which visits put a job on the week's production sheet", () => {
  it("counts roof, siding, gutters, windows, solar and shed installs", () => {
    for (const c of INSTALL_CODES) expect([c, isInstallCode(c)]).toEqual([c, true]);
    expect(isInstallCode("rr")).toBe(true);
    expect(isInstallCode("RR + SR")).toBe(true);
    expect(isInstallCode("RR/SR")).toBe(true);
  });
  it("leaves out service calls, callbacks, punch lists, site assessments and unknown titles", () => {
    for (const c of ["MS", "MS REPAIR", "MS-CB", "CB", "MS SA", "SA", "PL", "PUNCHLIST", "PH", "MS CHECK IN", "MATERIAL", "PICK UP PAYMENT", null, undefined, ""]) {
      expect([c, isInstallCode(c)]).toEqual([c, false]);
    }
  });
});
