import { describe, it, expect } from "vitest";
import {
  classifySalesAppointment, salesAppointmentsOnly, canonicalAppointmentKey,
} from "../src/salesAppointment.js";

describe("classifySalesAppointment", () => {
  it.each(["ROOF EST", "SIDING EST", "MISC EST", "REHASH ROOF EST", "NO SEE ROOF EST"])(
    "treats %s as a sales appointment", (title) => {
      expect(classifySalesAppointment(title).isSales).toBe(true);
    });

  it("does NOT treat ESTIMATING as the EST token", () => {
    // \best\b cannot match inside "estimating" — there is no word boundary after "est".
    expect(classifySalesAppointment("ESTIMATING IN PROGRESS").isSales).toBe(false);
  });

  it.each(["Warranty Callback", "WCB follow up", "Sample drop", "Walk Thru", "Customer Service", "Solar consult", "Unassigned"])(
    "excludes %s even when EST appears elsewhere", (title) => {
      expect(classifySalesAppointment(`${title} EST`).isSales).toBe(false);
    });

  it("reports a reason whenever it is not a sales appointment", () => {
    expect(classifySalesAppointment("").reason).toBe("Unassigned — no title");
    expect(classifySalesAppointment("Sample").reason).toMatch(/^Excluded — /);
    expect(classifySalesAppointment("Coffee").reason).toMatch(/^Non-EST — /);
  });
});

describe("salesAppointmentsOnly", () => {
  it("drops only records explicitly flagged false, keeping historical unset ones", () => {
    const out = salesAppointmentsOnly([
      { id: "a", is_sales_appointment: true },
      { id: "b", is_sales_appointment: false },
      { id: "c" }, // historical: field never set
    ]);
    expect(out.map((r) => r.id)).toEqual(["a", "c"]);
  });
});

describe("canonicalAppointmentKey", () => {
  it("normalizes case and surrounding whitespace", () => {
    expect(canonicalAppointmentKey(" ABC123 ", "2026-08-01", " 09:30 "))
      .toBe(canonicalAppointmentKey("abc123", "2026-08-01", "09:30"));
  });

  it("treats the same job on a different date or time as a DIFFERENT appointment", () => {
    // This is the identity the Postgres unique constraint enforces (MIGRATION_PLAN.md §7.2).
    const base = canonicalAppointmentKey("J1", "2026-08-01", "09:30");
    expect(canonicalAppointmentKey("J1", "2026-08-02", "09:30")).not.toBe(base);
    expect(canonicalAppointmentKey("J1", "2026-08-01", "14:00")).not.toBe(base);
  });
});
