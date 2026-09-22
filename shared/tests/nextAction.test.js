import { describe, it, expect } from "vitest";
import {
  ruleFor, needsModel, suggestionFacts, factsHash, validateSuggestion, DEFAULT_INSTRUCTIONS, NEXT_ACTION_RULES, OWNERS, SUGGESTION_MAX_WORDS,
} from "../src/nextAction.js";

const row = (over = {}) => ({
  jobId: "j1", customer: "Lisa Diss", jobNumber: "2609-0001-01", stage: "Install Accepted-> SUBMIT SS", bucket: "unscheduled",
  contract: 26749, noContractValue: false, contractSignedDate: "2026-09-16", daysSinceSold: 7, scheduledDate: null,
  trades: "ROOFING", division: "ACR Roofing Division", rep: "Jason Malarchak", blocker: "Awaiting sold-sheet handoff to production",
  blockerDerived: true, owner: null, nextAction: null, ...over,
});

describe("rules — the stage says what happens next", () => {
  it("names who acts, and sharpens with how long the job has waited", () => {
    expect(ruleFor(row())).toMatchObject({ key: "handoff", owner: OWNERS.rep });
    expect(ruleFor(row()).action).toBe("Sales rep submits the sold sheet so production can review the job.");
    expect(ruleFor(row({ daysSinceSold: 12 })).action).toContain("sold 12 days ago");
    expect(ruleFor(row({ stage: "Accepted/INS Claim Pending", daysSinceSold: 45 })).action).toBe("Sales rep calls the adjuster for a claim decision; 45 days pending.");
    expect(ruleFor(row({ stage: "Accepted/INS Claim Pending", daysSinceSold: 10 })).action).toBe("Sales rep follows up with the adjuster on the claim.");
    expect(ruleFor(row({ stage: "Accepted/No Deposit/Finance", daysSinceSold: 300 })).action).toContain("300 days since signing");
    expect(ruleFor(row({ stage: "COMPLETED NEED FINAL PAYMENT!!", bucket: "awaitingPayment" }))).toMatchObject({ key: "final_payment", owner: OWNERS.office });
    // Punctuation and spacing in stage names do not matter.
    expect(ruleFor(row({ stage: "install accepted ->  submit ss" })).key).toBe("handoff");
  });

  it("falls back to the bucket for scheduled and in-production jobs, and to nothing for a stage it does not know", () => {
    expect(ruleFor(row({ stage: "Something Odd", bucket: "scheduled", scheduledDate: "2026-10-06" })).action).toBe("Production confirms crew and materials the week before the 10/6/2026 install.");
    expect(ruleFor(row({ stage: "Something Odd", bucket: "inProduction" })).key).toBe("in_production");
    // The calendar outranks a lagging stage: booked means booked, whatever JobProgress still says.
    expect(ruleFor(row({ stage: "Approved New Installs", bucket: "scheduled", scheduledDate: "2026-10-06" })).key).toBe("scheduled");
    expect(ruleFor(row({ stage: "Install Accepted-> SUBMIT SS", bucket: "inProduction" })).key).toBe("in_production");
    expect(ruleFor(row({ stage: "Something Odd", bucket: "unscheduled" }))).toBeNull();
    // Every rule's stages resolve to itself, so a typo in the table would show here.
    for (const rule of NEXT_ACTION_RULES) for (const s of rule.stages) expect(ruleFor(row({ stage: s })).key, s).toBe(rule.key);
  });

  it("only spends a model call where the rule alone is not the answer", () => {
    expect(needsModel(row({ bucket: "unscheduled" }))).toBe(true);
    expect(needsModel(row({ bucket: "awaitingPayment" }))).toBe(true);
    expect(needsModel(row({ bucket: "scheduled" }))).toBe(false);
    expect(needsModel(row({ bucket: "inProduction" }))).toBe(false);
  });
});

describe("facts and hash — a job is re-asked only when something changed", () => {
  it("sends the facts that bear on the next step and nothing volatile", () => {
    const f = suggestionFacts(row());
    expect(f).toEqual({
      customer: "Lisa Diss", jobNumber: "2609-0001-01", stage: "Install Accepted-> SUBMIT SS", status: "unscheduled",
      contractValue: 26749, noContractValue: false, soldDate: "2026-09-16", daysSinceSold: 7, scheduledInstall: null,
      trade: "ROOFING", salesRep: "Jason Malarchak", blocker: "Awaiting sold-sheet handoff to production", blockerWrittenByTeam: false, owner: null,
      rule: { key: "handoff", action: "Sales rep submits the sold sheet so production can review the job.", owner: OWNERS.rep },
    });
    expect(JSON.stringify(f)).not.toMatch(/jobId|jpUrl|updatedAt/);
  });

  it("hashes the same situation the same, and differently when the stage, the days or the instructions move", () => {
    const a = factsHash(suggestionFacts(row()));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(factsHash(suggestionFacts(row()))).toBe(a);
    // Key order does not matter.
    expect(factsHash({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(factsHash({ a: [1, { c: 3, d: 2 }], b: 1 }));
    expect(factsHash(suggestionFacts(row({ stage: "Sales Review" })))).not.toBe(a);
    expect(factsHash(suggestionFacts(row({ daysSinceSold: 8 })))).not.toBe(a);
    expect(factsHash(suggestionFacts(row()), "other instructions")).not.toBe(a);
  });
});

describe("validateSuggestion — one short sentence or nothing", () => {
  it("accepts a clean reply, with or without code fences, and defaults the confidence", () => {
    expect(validateSuggestion('{"suggestion":"Sales rep submits the sold sheet today.","confidence":"high"}')).toEqual({ suggestion: "Sales rep submits the sold sheet today.", confidence: "high" });
    expect(validateSuggestion('```json\n{"suggestion": "Office enters the contract price in JobProgress first"}\n```')).toEqual({ suggestion: "Office enters the contract price in JobProgress first.", confidence: "medium" });
    expect(validateSuggestion({ suggestion: "Production books the install and confirms the date.", confidence: "low" }).confidence).toBe("low");
    expect(validateSuggestion('{"suggestion":"Rep calls the adjuster.","confidence":"certain"}').confidence).toBe("medium");
  });

  it("cuts a second sentence, and rejects rambling, empty or non-JSON replies", () => {
    expect(validateSuggestion('{"suggestion":"Sales rep calls the customer. Then production books it and orders material."}').suggestion).toBe("Sales rep calls the customer.");
    const long = "word ".repeat(SUGGESTION_MAX_WORDS + 10).trim();
    expect(validateSuggestion(JSON.stringify({ suggestion: long }))).toBeNull();
    expect(validateSuggestion('{"suggestion":"Do it"}')).toBeNull();
    expect(validateSuggestion("I think the rep should call.")).toBeNull();
    expect(validateSuggestion("")).toBeNull();
    expect(validateSuggestion(null)).toBeNull();
  });

  it("ships starter instructions a manager can read and edit", () => {
    expect(DEFAULT_INSTRUCTIONS).toContain("Money first");
    expect(DEFAULT_INSTRUCTIONS).toContain("Start with WHO does it");
    expect(DEFAULT_INSTRUCTIONS.length).toBeGreaterThan(400);
  });
});
