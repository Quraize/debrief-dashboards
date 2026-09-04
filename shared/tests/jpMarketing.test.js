import { describe, it, expect } from "vitest";
import { jpLeadSource, jpLeadCategory, jpMarketingStats, UNKNOWN_SOURCE, CUSTOMER_REFERRAL_SOURCE } from "../src/jpMarketing.js";

const customer = (over = {}) => ({
  jp_customer_id: "1", referred_by_type: "referral", referred_by_name: "Networx Direct Calls",
  referred_by_note: null, jp_created_at: "2026-08-10T14:00:00.000Z", ...over,
});
const appt = (over = {}) => ({
  jp_appointment_id: "a1", appointment_date: "2026-08-12", is_sales_type: true, is_insurance: false,
  has_result: true, result_option_name: "Demo No Sale", jp_customer_id: "1", crm_job_id: null, ...over,
});

describe("jpLeadSource — resolving the CRM customer's source", () => {
  it("prefers the referral name, then existing-customer referral, then the note, then unknown", () => {
    expect(jpLeadSource(customer())).toEqual({ source: "Networx Direct Calls", kind: "referral" });
    expect(jpLeadSource(customer({ referred_by_name: null, referred_by_type: "customer" })))
      .toEqual({ source: CUSTOMER_REFERRAL_SOURCE, kind: "customer" });
    expect(jpLeadSource(customer({ referred_by_name: null, referred_by_type: "", referred_by_note: "REFERRED BY STEVE" })).kind).toBe("note");
    expect(jpLeadSource(customer({ referred_by_name: "  ", referred_by_type: "", referred_by_note: "" })))
      .toEqual({ source: UNKNOWN_SOURCE, kind: "unknown" });
    expect(jpLeadSource(null).kind).toBe("unknown");
  });

  it("rolls up to the debrief dashboard's categories", () => {
    expect(jpLeadCategory({ source: "Google Paid - WR", kind: "referral" })).toBe("WebRunner");
    expect(jpLeadCategory({ source: "Home Avengers", kind: "referral" })).toBe("Lead Aggregators / Purchased Leads");
    expect(jpLeadCategory({ source: CUSTOMER_REFERRAL_SOURCE, kind: "customer" })).toBe("Existing Customer / Referral");
    expect(jpLeadCategory({ source: "Note: whatever", kind: "note" })).toBe("Other / Needs Cleanup");
    expect(jpLeadCategory({ source: "Brand New Source", kind: "referral" })).toBe("Other / Needs Cleanup");
  });
});

describe("jpMarketingStats", () => {
  const customers = [
    customer({ jp_customer_id: "1" }),                                                       // Networx
    customer({ jp_customer_id: "2", referred_by_name: "Google Paid - WR" }),
    customer({ jp_customer_id: "3", referred_by_name: null, referred_by_type: "customer" }), // existing-customer referral
    customer({ jp_customer_id: "4", referred_by_name: null, referred_by_type: "", referred_by_note: null }), // unknown
    customer({ jp_customer_id: "5", referred_by_name: "Mystery Portal" }),                   // unmapped referral name
    customer({ jp_customer_id: "6", jp_created_at: "2026-07-02T10:00:00.000Z" }),           // outside period
  ];
  const appointments = [
    appt({ jp_appointment_id: "a1", jp_customer_id: "1", result_option_name: "$ale!!!", crm_job_id: "J1" }),
    appt({ jp_appointment_id: "a2", jp_customer_id: "1", result_option_name: "No See" }),
    appt({ jp_appointment_id: "a3", jp_customer_id: "2", result_option_name: "Demo No Sale" }),
    appt({ jp_appointment_id: "a4", jp_customer_id: "6", result_option_name: "No Demo" }),  // lead from July, appointment in August
    appt({ jp_appointment_id: "a5", jp_customer_id: "999", result_option_name: "$ale!!!" }), // customer not in mirror → unknown
    appt({ jp_appointment_id: "a6", jp_customer_id: "1", has_result: false, result_option_name: null }), // awaiting: not counted
    appt({ jp_appointment_id: "a7", jp_customer_id: "1", is_insurance: true, result_option_name: "$ale!!!" }), // insurance: excluded
  ];
  const jobs = [{ jp_job_id: "J1", total_job_price: "21000" }];

  it("counts leads by creation date and appointments by appointment date, attributed through the customer", () => {
    const s = jpMarketingStats(customers, appointments, jobs, "Custom Range", "2026-08-01", "2026-08-31");
    expect(s.leads).toBe(5);
    expect(s.customerReferrals).toBe(1);
    expect(s.unknownLeads).toBe(1);
    expect(s.appointments).toBe(4);   // a1, a3, a4, a5
    expect(s.noShows).toBe(1);
    expect(s.demos).toBe(3);          // a1 sale, a3 demo no sale, a5 sale
    expect(s.sales).toBe(2);
    expect(s.salesAmount).toBe(21000);
    expect(s.salesMissingAmount).toBe(1);
    expect(s.unmappedSources).toEqual(["Mystery Portal"]);
  });

  it("breaks down by source and category", () => {
    const s = jpMarketingStats(customers, appointments, jobs, "Custom Range", "2026-08-01", "2026-08-31");
    const networx = s.bySource.find((r) => r.label === "Networx Direct Calls");
    // a1 (sale) + a4 (no demo, on a July lead) run; a2 was a no-show.
    expect(networx).toMatchObject({ leads: 1, appointments: 2, noShows: 1, demos: 1, sales: 1, salesAmount: 21000 });
    const unknown = s.bySource.find((r) => r.label === UNKNOWN_SOURCE);
    expect(unknown).toMatchObject({ leads: 1, appointments: 1, sales: 1 });
    const outbound = s.byCategory.find((r) => r.label === "Networx");
    expect(outbound.leads).toBe(1);
    expect(s.byCategory.find((r) => r.label === "Existing Customer / Referral").leads).toBe(1);
    expect(s.leadsByMonth).toEqual([{ month: "2026-08", leads: 5 }]);
  });

  it("is empty-safe", () => {
    const s = jpMarketingStats([], [], [], "This Month", "", "");
    expect(s.leads).toBe(0);
    expect(s.bySource).toEqual([]);
    expect(s.leadToApptRate).toBe(0);
  });
});
