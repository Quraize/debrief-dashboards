import { describe, it, expect } from "vitest";
import { leadFlow, leadFunnel, leadReason, leadStatus, isLeadStage, isDisqualifiedStage, LEAD_REASONS } from "../src/leadFlow.js";

const lead = (stage, has_appointment = false, debriefs = []) => ({ current_stage: stage, has_appointment, debriefs });
const d = (outcome, over = {}) => ({ appointment_type: "First Appointment", appointment_outcome: outcome, ...over });

describe("leadReason / isLeadStage", () => {
  it("recognises the DQ stages, tolerant of their punctuation", () => {
    expect(isDisqualifiedStage("DQ (MGR APPROVAL)")).toBe(true);
    expect(isDisqualifiedStage("dq (mgr approval)")).toBe(true);
    expect(isDisqualifiedStage("Disqualified Lead")).toBe(true);
    expect(isDisqualifiedStage("LEAD NOT CONTACTED!!!")).toBe(false);
    expect(isDisqualifiedStage(null)).toBe(false);
  });

  it("maps the office's stage names, tolerant of their punctuation", () => {
    expect(leadReason("LEAD NOT CONTACTED!!!")).toBe("working");
    expect(leadReason("Contacted Needs Follow Up")).toBe("working");
    expect(leadReason("Est In Progress(MGR APPROVAL)")).toBe("working"); // an estimate is out: being worked
    expect(leadReason("Project On Hold")).toBe("hold");
    expect(leadReason("Cancel: FOLLOW UP (MGR APPR)")).toBe("cancelled");
    expect(leadReason("Paid Don't Contact")).toBe("dnc");
    expect(leadReason("Rehash Monthly: DNS Follow UP")).toBe("other");
    expect(leadReason(null)).toBe("other");
  });

  it("does not count warranty callbacks as leads", () => {
    expect(isLeadStage("Open Warranty Claims/CallBacks")).toBe(false);
    expect(isLeadStage("Warranty")).toBe(false);
    expect(isLeadStage("LEAD NOT CONTACTED!!!")).toBe(true);
    expect(isLeadStage(null)).toBe(true);
  });
});

describe("leadStatus — one lead, from its debriefs", () => {
  it("reads the best thing that happened to the lead across all its visits", () => {
    expect(leadStatus([])).toBe("awaiting");
    expect(leadStatus([d("No C / No Show — Reset Needed")])).toBe("noSee");
    expect(leadStatus([d("No C / No Show — Reset Needed"), d("Demo Completed — Demo No Sale", { appointment_type: "Reset Demo" })])).toBe("demo");
    expect(leadStatus([d("No Demo — Reset Needed")])).toBe("noDemo");
    expect(leadStatus([d("Estimating in Progress — Proposal Not Yet Sent")])).toBe("pending");
    expect(leadStatus([d("Rescheduled Before Appointment")])).toBe("awaiting");
  });

  it("ignores a DQ debrief that a manager has not approved yet", () => {
    expect(leadStatus([d("No Demo — DQ / Do Not Reset", { approval_status: "pending" })])).toBe("awaiting");
    expect(leadStatus([d("No Demo — DQ / Do Not Reset", { approval_status: "approved" })])).toBe("noDemo");
  });
});

describe("leadFunnel", () => {
  const rows = [
    lead("Demo No Sale", true, [d("Demo Completed — Sale", { sale_amount: 20000 })]),
    lead("Demo No Sale", true, [d("Demo Completed — Demo No Sale")]),
    lead("Rehash Weekly: DNS Follow Up", true, [d("Demo Completed — Demo No Sale", { sale_amount: 14399, sale_signed_date: "2026-09-09" })]), // sold later
    lead("No Demo: RESET APPOINTMENT", true, [d("No Demo — Reset Needed")]),
    lead("Est In Progress(MGR APPROVAL)", true, [d("Estimating in Progress — Proposal Not Yet Sent")]),
    lead("Job Lost No See (Mgr Approval)", true, [d("No C / No Show — Do Not Reset")]),
    lead("Appointment Set", true, []),                                    // booked, not yet run
    lead("DQ (MGR APPROVAL)"),
    lead("DQ (MGR APPROVAL)"),
    lead("LEAD NOT CONTACTED!!!"),
    lead("Project On Hold"),
    lead("Cancel: NO FOLLOW UP(MGR APPR)"),
    lead("Appointment Set", false),                                       // sounds set; is not
    lead("Open Warranty Claims/CallBacks"),                               // not a lead at all
  ];

  it("counts leads once each and sums exactly at every level", () => {
    const f = leadFunnel(rows);
    expect(f.leads).toBe(13); // the warranty callback is gone
    expect(f.valid + f.disqualified).toBe(f.leads);   // the CEO's step: valid = leads − disqualified
    expect(f.set + f.notSet).toBe(f.valid);
    expect(f.ran + f.noSee + f.awaiting).toBe(f.set);
    expect(f.demo + f.noDemo + f.pending).toBe(f.ran);
    expect(f.sold + f.notSold).toBe(f.demo);
    expect(f).toMatchObject({ valid: 11, disqualified: 2, set: 7, notSet: 4, ran: 5, noSee: 1, awaiting: 1, demo: 3, noDemo: 1, pending: 1, sold: 2, notSold: 1, revenue: 34399 });
    expect(f.reasons.reduce((s, r) => s + r.count, 0)).toBe(f.notSet);
    expect(Object.fromEntries(f.reasons.map((r) => [r.key, r.count]))).toEqual({ working: 2, hold: 1, cancelled: 1, dnc: 0, other: 0 });
  });

  it("disqualifies by stage even when an appointment exists", () => {
    const f = leadFunnel([lead("DQ (MGR APPROVAL)", true, [d("Demo Completed — Sale", { sale_amount: 100 })]), lead("Demo No Sale", true, [d("Demo Completed — Demo No Sale")])]);
    expect(f).toMatchObject({ leads: 2, disqualified: 1, valid: 1, set: 1, demo: 1, sold: 0 });
  });

  it("states each box as a share of its parent", () => {
    const f = leadFunnel(rows);
    expect(f.validRate).toBe(85); // 11 of 13
    expect(f.setRate).toBe(64);   // 7 of 11 valid
    expect(f.ranRate).toBe(71);   // 5 of 7
    expect(f.demoRate).toBe(60);  // 3 of 5
    expect(f.soldRate).toBe(67);  // 2 of 3
  });

  it("is zero-safe and keeps the header view", () => {
    expect(leadFunnel([])).toMatchObject({ leads: 0, valid: 0, disqualified: 0, set: 0, ran: 0, sold: 0, revenue: 0, validRate: 0, setRate: 0, soldRate: 0 });
    expect(leadFlow(rows)).toMatchObject({ leads: 13, valid: 11, disqualified: 2, set: 7, notSet: 4 });
    expect(leadFlow([]).reasons.map((r) => r.key)).toEqual(LEAD_REASONS.map((r) => r.key));
  });
});
