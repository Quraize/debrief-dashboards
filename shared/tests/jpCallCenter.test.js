import { describe, it, expect } from "vitest";
import { jpCallCenterStats, nameKey, REP_SELF_BOOKED, UNKNOWN_SETTER } from "../src/jpCallCenter.js";

const appt = (over = {}) => ({
  jp_appointment_id: "a", appointment_date: "2026-08-12", jp_created_at: "2026-08-01T13:00:00.000Z",
  is_sales_type: true, is_insurance: false, has_result: true, result_option_name: "Demo No Sale",
  appointment_setter: "Ashley  Pascual", sales_rep: "Jason Malarchak", two_leg_answer: null, title: "ROOF EST: Town/1 Main/Cust",
  crm_job_id: null, ...over,
});
const customer = (over = {}) => ({ jp_customer_id: "c", jp_created_at: "2026-08-05T10:00:00.000Z", call_center_rep: "Ashley Pascual", ...over });
const NOW = new Date("2026-09-15T12:00:00");

describe("nameKey", () => {
  it("ignores the CRM's double spaces and case", () => {
    expect(nameKey("Ashley  Pascual")).toBe(nameKey("ashley pascual"));
    expect(nameKey(null)).toBe("");
  });
});

describe("jpCallCenterStats", () => {
  const appointments = [
    appt({ jp_appointment_id: "1", result_option_name: "$ale!!!", crm_job_id: "J1", two_leg_answer: "two_leg" }),
    appt({ jp_appointment_id: "2", result_option_name: "No See" }),
    appt({ jp_appointment_id: "3", result_option_name: "No Demo", title: "NS RESET ROOF EST", two_leg_answer: "one_leg" }),
    appt({ jp_appointment_id: "4", appointment_setter: "Vanessa Martinez", result_option_name: "Demo No Sale", two_leg_answer: "two_leg" }),
    appt({ jp_appointment_id: "5", appointment_setter: "Jason Malarchak" }),                       // rep booked his own
    appt({ jp_appointment_id: "6", appointment_setter: null, has_result: false, result_option_name: null }), // nobody recorded, awaiting
    appt({ jp_appointment_id: "7", has_result: false, result_option_name: null, title: "CANCELLED ROOF EST" }),
    appt({ jp_appointment_id: "8", appointment_date: "2026-09-20", jp_created_at: "2026-08-20T09:00:00.000Z" }), // booked in Aug for Sep
    appt({ jp_appointment_id: "9", is_insurance: true, result_option_name: "$ale!!!" }),           // excluded
    appt({ jp_appointment_id: "10", is_sales_type: false, title: "FINAL WALK THROUGH" }),         // excluded
  ];
  const customers = [
    customer({ jp_customer_id: "c1" }), customer({ jp_customer_id: "c2" }),
    customer({ jp_customer_id: "c3", call_center_rep: "Vanessa Martinez" }),
    customer({ jp_customer_id: "c4", call_center_rep: "" }),
    customer({ jp_customer_id: "c5", jp_created_at: "2026-07-01T10:00:00.000Z" }), // outside period
  ];
  const jobs = [{ jp_job_id: "J1", total_job_price: "27000" }];

  it("computes team totals by appointment date, with leads assigned by customer creation date", () => {
    const s = jpCallCenterStats(appointments, customers, jobs, "Custom Range", "2026-08-01", "2026-08-31", NOW);
    expect(s).toMatchObject({
      leadsAssigned: 3, leadsUnassigned: 1,
      set: 7, run: 4, noSee: 1, pending: 2, cancelled: 1,
      demos: 3, sales: 1, salesAmount: 27000, twoLeg: 2, oneLeg: 1, resets: 1,
      bookedThisPeriod: 8,
    });
    expect(s.showRate).toBe(80);   // 4 / 5
    expect(s.demoRate).toBe(75);   // 3 / 4
    expect(s.twoLegRate).toBe(67);
    expect(s.ser).toBe(90);        // 27000 / 3 / 100
    expect(s.serRating).toBe("Poor");
    expect(s.setRate).toBe(233);   // 7 set / 3 leads — the tooltip says why this can exceed 100
  });

  it("groups by booker, merging spacing variants, and collapses rep self-bookings", () => {
    const s = jpCallCenterStats(appointments, customers, jobs, "Custom Range", "2026-08-01", "2026-08-31", NOW);
    const labels = s.bySetter.map((r) => r.label);
    expect(labels[0]).toBe("Ashley Pascual");
    expect(labels).toContain("Vanessa Martinez");
    expect(labels).toContain(UNKNOWN_SETTER);
    expect(labels[labels.length - 1]).toBe(REP_SELF_BOOKED);

    const ashley = s.bySetter[0];
    // 1 sale, 2 no-see, 3 reset no-demo, 7 cancelled → set 4, run 2, leads 2 (spacing variants merged)
    expect(ashley).toMatchObject({ leadsAssigned: 2, set: 4, run: 2, noSee: 1, demos: 1, sales: 1, salesAmount: 27000, resets: 1, cancelled: 1 });
    expect(ashley.ser).toBe(270);
    expect(ashley.serRating).toBe("Excellent");
    const reps = s.bySetter.find((r) => r.label === REP_SELF_BOOKED);
    expect(reps).toMatchObject({ isReps: true, set: 1, run: 1, demos: 1 });
  });

  it("works before the customer sync has ever run", () => {
    const s = jpCallCenterStats(appointments, [], jobs, "Custom Range", "2026-08-01", "2026-08-31", NOW);
    expect(s.hasLeadData).toBe(false);
    expect(s.leadsAssigned).toBe(0);
    expect(s.set).toBe(7);
  });
});
