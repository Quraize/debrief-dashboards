import { describe, it, expect } from "vitest";
import { classifyAppointment, getRawDivisionDisplay } from "../src/appointmentClassification.js";

describe("classifyAppointment", () => {
  it("treats Insurance as an override, ahead of any trade", () => {
    const c = classifyAppointment({ business_division: "Insurance", product: "Roofing", trade: "Roofing" });
    expect(c.reporting_division).toBe("Insurance");
    expect(c.two_leg_eligible).toBe(false); // Insurance never counts toward retail two-leg
  });

  it("prefers a genuine JobProgress Division over the title", () => {
    const c = classifyAppointment({ product: "ACR Roofing Division", title: "ROOF EST" });
    expect(c.reporting_division).toBe("Roofing");
    expect(c.classification_source).toBe("JobProgress Division");
  });

  it("detects combined roofing + siding before either alone", () => {
    expect(classifyAppointment({ product: "Roofing and Siding Division" }).reporting_division)
      .toBe("Roofing + Siding");
  });

  it("ignores a title masquerading as a Division and falls back to the title", () => {
    const c = classifyAppointment({ product: "ROOF EST: 12 Main St / Smith", title: "ROOF EST" });
    expect(c.classification_source).toBe("Appointment Title Fallback");
    expect(c.reporting_division).toBe("Roofing");
  });

  it("returns Unclassified rather than guessing", () => {
    expect(classifyAppointment({}).reporting_division).toBe("Unclassified");
    expect(classifyAppointment(null).reporting_division).toBe("Unclassified");
  });

  it("marks only Roofing, Siding and Roofing + Siding as two-leg eligible", () => {
    const eligible = ["Roofing Division", "Siding Division", "Roofing and Siding Division"];
    const not = ["Commercial Division", "Service and Repair", "Windows Division"];
    for (const p of eligible) expect(classifyAppointment({ product: p }).two_leg_eligible).toBe(true);
    for (const p of not) expect(classifyAppointment({ product: p }).two_leg_eligible).toBe(false);
  });
});

describe("getRawDivisionDisplay", () => {
  it("hides title-like values instead of presenting them as Division data", () => {
    expect(getRawDivisionDisplay({ product: "ROOF EST: 12 Main St", title: "ROOF EST" }))
      .toBe("Not provided in appointment export");
    expect(getRawDivisionDisplay({ product: "ACR Roofing Division" })).toBe("ACR Roofing Division");
  });
});
