import { describe, it, expect } from "vitest";
import { leadFlow, leadReason, LEAD_REASONS } from "../src/leadFlow.js";

const lead = (stage, has_appointment = false) => ({ current_stage: stage, has_appointment });

describe("leadReason", () => {
  it("maps the office's stage names, tolerant of their punctuation", () => {
    expect(leadReason("DQ (MGR APPROVAL)")).toBe("dq");
    expect(leadReason("dq (mgr approval)")).toBe("dq");
    expect(leadReason("Disqualified Lead")).toBe("dq");
    expect(leadReason("LEAD NOT CONTACTED!!!")).toBe("working");
    expect(leadReason("Contacted Needs Follow Up")).toBe("working");
    expect(leadReason("Project On Hold")).toBe("hold");
    expect(leadReason("Cancel: FOLLOW UP (MGR APPR)")).toBe("cancelled");
    expect(leadReason("Paid Don't Contact")).toBe("dnc");
    expect(leadReason("Rehash Monthly: DNS Follow UP")).toBe("other");
    expect(leadReason(null)).toBe("other");
  });
});

describe("leadFlow", () => {
  const rows = [
    lead("Appointment Set", true),
    lead("Demo No Sale", true),
    lead("Job Lost DNS (MGR APPROVAL)", true),
    lead("DQ (MGR APPROVAL)"),
    lead("DQ (MGR APPROVAL)"),
    lead("LEAD NOT CONTACTED!!!"),
    lead("Project On Hold"),
    lead("Cancel: NO FOLLOW UP(MGR APPR)"),
    lead("Rehash Weekly: DNS Follow Up"),
    // A stage that sounds set is not "set" without an actual appointment.
    lead("Appointment Set", false),
  ];

  it("splits leads into set and not set by the appointment, and buckets the rest by stage", () => {
    const f = leadFlow(rows);
    expect(f).toMatchObject({ leads: 10, set: 3, notSet: 7, setRate: 30, notSetRate: 70 });
    const by = Object.fromEntries(f.reasons.map((r) => [r.key, r.count]));
    expect(by).toEqual({ dq: 2, working: 2, hold: 1, cancelled: 1, dnc: 0, other: 1 });
    expect(f.reasons.reduce((s, r) => s + r.count, 0)).toBe(f.notSet);
    expect(f.reasons.find((r) => r.key === "dq").share).toBe(29); // 2 of 7 not set
  });

  it("keeps the reasons in display order and is zero-safe", () => {
    expect(leadFlow([]).reasons.map((r) => r.key)).toEqual(LEAD_REASONS.map((r) => r.key));
    expect(leadFlow(undefined)).toMatchObject({ leads: 0, set: 0, notSet: 0, setRate: 0 });
  });
});
