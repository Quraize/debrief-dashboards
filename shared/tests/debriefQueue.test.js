import { describe, it, expect } from "vitest";
import {
  crmKey, indexJpAppointments, indexById, jobProgressJobUrl, crmStatus, enrichQueueItem,
  daysSince, queueDisposition, localDay, EXCLUDED_CRM_STATUSES,
} from "../src/debriefQueue.js";

const NOW = new Date("2026-09-08T10:00:00");

const appt = (over = {}) => ({
  id: "a1", crm_lead_id: "J-100", crm_job_id: "7001", appointment_date: "2026-09-03", debrief_status: "Missing", ...over,
});
const jp = (over = {}) => ({
  jp_appointment_id: "1", crm_lead_id: "j-100 ", crm_job_id: "7001", jp_customer_id: "9001", appointment_date: "2026-09-03",
  title: "ROOF EST: Town/1 Main/Cust", is_sales_type: true, is_insurance: false, has_result: true,
  result_option_name: "Demo No Sale", two_leg_answer: "two_leg", two_leg_raw: "2 legs", division: "ACR Roofing Division",
  sales_rep: "Jason Malarchak", appointment_setter: "Ashley Pascual", jp_created_at: "2026-08-20T13:00:00.000Z", ...over,
});

describe("crmKey / indexes", () => {
  it("normalizes case, whitespace and date precision", () => {
    expect(crmKey(" J-100", "2026-09-03T00:00:00")).toBe("j-100|2026-09-03");
    expect(crmKey(null, "2026-09-03")).toBeNull();
    expect(crmKey("J-100", "")).toBeNull();
  });

  it("prefers the CRM entry with a result form when a day has two", () => {
    const withResult = jp({ jp_appointment_id: "2" });
    const noResult = jp({ jp_appointment_id: "1", has_result: false, result_option_name: null });
    expect(indexJpAppointments([noResult, withResult]).get("j-100|2026-09-03")).toBe(withResult);
    expect(indexJpAppointments([withResult, noResult]).get("j-100|2026-09-03")).toBe(withResult);
    expect(indexJpAppointments([jp({ crm_lead_id: null })]).size).toBe(0);
  });

  it("indexes by any id field as a string", () => {
    expect(indexById([{ jp_job_id: 7001 }], "jp_job_id").get("7001")).toEqual({ jp_job_id: 7001 });
    expect(indexById([{ jp_job_id: null }], "jp_job_id").size).toBe(0);
  });

  it("builds the JobProgress deep link only with both ids", () => {
    expect(jobProgressJobUrl("9001", "7001")).toBe("https://app.jobprogress.com/#/customer-jobs/9001/job/7001/overview");
    expect(jobProgressJobUrl(null, "7001")).toBeNull();
  });
});

describe("crmStatus", () => {
  it("maps the result form and its absence to the dashboard's buckets", () => {
    expect(crmStatus(null)).toBeNull();
    expect(crmStatus(jp())).toBe("run");
    expect(crmStatus(jp({ result_option_name: "No See" }))).toBe("no_see");
    expect(crmStatus(jp({ has_result: false, result_option_name: null }), NOW)).toBe("awaiting");
    expect(crmStatus(jp({ has_result: false, result_option_name: null, appointment_date: "2026-08-01" }), NOW)).toBe("no_result");
    expect(crmStatus(jp({ has_result: false, result_option_name: null, title: "CANCELLED ROOF EST" }), NOW)).toBe("cancelled");
    expect(crmStatus(jp({ has_result: false, result_option_name: null, appointment_date: "2026-09-20" }), NOW)).toBe("upcoming");
  });
});

describe("enrichQueueItem", () => {
  const ctx = {
    jpByKey: indexJpAppointments([jp()]),
    customersById: indexById([{ jp_customer_id: "9001", referred_by_name: "Google Ads", call_center_rep: "Ashley Pascual", canvasser: "", jp_created_at: "2026-08-19T00:00:00Z" }], "jp_customer_id"),
    jobsById: indexById([{ jp_job_id: "7001", job_number: "J-100", current_stage: "Awarded", stage_color: "#0a0", contract_signed_date: "2026-09-04", total_job_price: "27000.00" }], "jp_job_id"),
  };

  it("joins the CRM appointment, lead and job onto the queue row", () => {
    const e = enrichQueueItem(appt(), ctx, NOW);
    expect(e.crm).toMatchObject({
      status: "run", result: "Demo No Sale", isSale: false, isDemo: true, twoLeg: "two_leg", twoLegRaw: "2 legs",
      jobType: "Roof Replacement", salesRep: "Jason Malarchak", setter: "Ashley Pascual", isReset: false, isRehash: false,
      jpUrl: "https://app.jobprogress.com/#/customer-jobs/9001/job/7001/overview",
    });
    expect(e.lead).toMatchObject({ source: "Google Ads", kind: "referral", callCenterRep: "Ashley Pascual" });
    expect(e.job).toMatchObject({ jobNumber: "J-100", stage: "Awarded", signedDate: "2026-09-04", price: 27000 });
    expect(e.daysSince).toBe(5);
  });

  it("degrades to nulls when the CRM mirror has nothing for the row", () => {
    const e = enrichQueueItem(appt({ crm_lead_id: "J-999", crm_job_id: null }), ctx, NOW);
    expect(e).toMatchObject({ crm: null, lead: null, job: null, daysSince: 5 });
  });

  it("falls back to the appointment's own job id for the job join", () => {
    const e = enrichQueueItem(appt({ crm_lead_id: "J-999" }), ctx, NOW);
    expect(e.crm).toBeNull();
    expect(e.job?.jobNumber).toBe("J-100");
  });

  it("treats a zero contract value as unknown", () => {
    const jobsById = indexById([{ jp_job_id: "7001", total_job_price: "0", total_job_revenue: null }], "jp_job_id");
    expect(enrichQueueItem(appt(), { ...ctx, jobsById }, NOW).job.price).toBeNull();
  });
});

describe("daysSince / localDay", () => {
  it("counts whole days on the local clock and ignores the future", () => {
    expect(localDay(NOW)).toBe("2026-09-08");
    expect(daysSince("2026-09-08", NOW)).toBe(0);
    expect(daysSince("2026-09-01T00:00:00", NOW)).toBe(7);
    expect(daysSince("2026-09-09", NOW)).toBeNull();
    expect(daysSince(null, NOW)).toBeNull();
  });
});

describe("queueDisposition", () => {
  const crm = (status) => ({ status });
  it("keeps run and awaiting appointments in the queue, drops what the CRM says never happened", () => {
    expect(queueDisposition(appt(), null, false, NOW)).toBe("missing");
    expect(queueDisposition(appt(), crm("run"), false, NOW)).toBe("missing");
    expect(queueDisposition(appt(), crm("awaiting"), false, NOW)).toBe("missing");
    for (const s of EXCLUDED_CRM_STATUSES) expect(queueDisposition(appt(), crm(s), false, NOW)).toBe("excluded");
  });
  it("respects debriefs, dates and non-missing statuses", () => {
    expect(queueDisposition(appt(), crm("run"), true, NOW)).toBe("debriefed");
    expect(queueDisposition(appt({ appointment_date: "2026-09-09" }), crm("upcoming"), false, NOW)).toBe("upcoming");
    expect(queueDisposition(appt({ appointment_date: null }), null, false, NOW)).toBe("upcoming");
    expect(queueDisposition(appt({ debrief_status: "Needs Review" }), crm("run"), false, NOW)).toBe("other");
    expect(queueDisposition(appt({ debrief_status: "Unmatched" }), null, false, NOW)).toBe("missing");
  });
});
