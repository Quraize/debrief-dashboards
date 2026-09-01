import { describe, it, expect } from "vitest";
import { normalizeAppointmentType, CANONICAL_APPOINTMENT_TYPES } from "../src/appointmentTypes.js";

describe("normalizeAppointmentType", () => {
  it.each([
    ["New Appointment", "First Appointment"],
    ["first appt", "First Appointment"],
    ["FIRST APPOINTMENT", "First Appointment"],
    ["Re-engagement", "Rehash"],
    ["reengagement", "Rehash"],
    ["re  hash", "Rehash"],
    ["reset demo", "Reset Demo"],
  ])("maps legacy %s -> %s", (raw, canonical) => {
    expect(normalizeAppointmentType(raw)).toBe(canonical);
  });

  it("returns empty string for blank input", () => {
    for (const blank of ["", null, undefined]) expect(normalizeAppointmentType(blank)).toBe("");
  });

  it("passes unknown values through trimmed, so new labels are never silently dropped", () => {
    expect(normalizeAppointmentType("  Some Future Type  ")).toBe("Some Future Type");
  });

  it("every canonical label normalizes to itself (idempotent)", () => {
    for (const t of CANONICAL_APPOINTMENT_TYPES) expect(normalizeAppointmentType(t)).toBe(t);
  });
});
