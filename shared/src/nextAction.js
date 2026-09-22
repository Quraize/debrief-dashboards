// Next Action suggestions for the Sold-Job Pipeline — regulated, in layers.
//
//   1. RULES first. The JobProgress stage already says what has to happen
//      next for most sold jobs; a table below turns that into one sentence,
//      deterministically and for free. Scheduled and in-production jobs need
//      nothing more than this.
//   2. The MODEL second, only for unscheduled and awaiting-payment jobs. It
//      gets the managers' standing instructions (text they edit on the page),
//      the job's facts, and the rule that fired, and must answer with ONE
//      sentence of at most twenty words naming who does what. It cannot
//      invent a policy: it phrases and prioritises inside the managers' words.
//   3. A suggestion stays a suggestion. It is shown in italics until a person
//      accepts it or types their own, and it never overwrites what a person
//      wrote.
//
// Everything the model is told is derived from the facts below and hashed,
// so a job is only sent to the model again when something about it changed.

import { stageKey } from "./jobStages.js";

/** Who is expected to act, as the rules name them. */
export const OWNERS = { rep: "Sales rep", salesManager: "Sales manager", production: "Production", office: "Office" };

const days = (r) => Number(r?.daysSinceSold) || 0;

/**
 * Stage → next action. `action(row)` returns the sentence; `owner` is a hint
 * for an empty Owner cell. Order matters only for readability.
 */
export const NEXT_ACTION_RULES = [
  { key: "handoff", owner: OWNERS.rep, stages: ["Install Accepted-> SUBMIT SS", "Repair Accepted-> SUBMIT SS"],
    action: (r) => `Sales rep submits the sold sheet so production can review the job${days(r) > 7 ? `; sold ${days(r)} days ago` : ""}.` },
  { key: "sales_review", owner: OWNERS.salesManager, stages: ["Sales Review"],
    action: () => "Sales manager completes the sales review and releases the job to production." },
  { key: "production_review", owner: OWNERS.production, stages: ["Production Review"],
    action: () => "Production reviews the job and approves it for scheduling." },
  { key: "book_install", owner: OWNERS.production, stages: ["Approved New Installs", "Approved Service/Repairs"],
    action: () => "Production puts the install on the calendar and confirms the date with the customer." },
  { key: "deposit", owner: OWNERS.rep, stages: ["Accepted/No Deposit/Finance", "Accepted/Needs Financing"],
    action: (r) => `Sales rep collects the deposit or completes the financing application${days(r) > 14 ? `; ${days(r)} days since signing` : ""}.` },
  { key: "insurance", owner: OWNERS.rep, stages: ["Accepted/INS Claim Pending"],
    action: (r) => (days(r) > 30 ? `Sales rep calls the adjuster for a claim decision; ${days(r)} days pending.` : "Sales rep follows up with the adjuster on the claim.") },
  { key: "credit_hold", owner: OWNERS.salesManager, stages: ["On Hold/Credit DQ (MGR APPR)", "On Hold/Financing Decline"],
    action: () => "Sales manager offers the customer another lender or a cash option, or closes the job." },
  { key: "on_hold", owner: OWNERS.rep, stages: ["Project On Hold"],
    action: () => "Sales rep contacts the customer to confirm whether the project is still going ahead." },
  { key: "final_payment", owner: OWNERS.office, stages: ["COMPLETED NEED FINAL PAYMENT!!"],
    action: () => "Office invoices the balance and collects the final payment." },
  { key: "collections", owner: OWNERS.office, stages: ["Collections"],
    action: () => "Office follows the collections process and records each contact." },
];
const RULE_BY_STAGE = new Map();
for (const rule of NEXT_ACTION_RULES) for (const s of rule.stages) RULE_BY_STAGE.set(stageKey(s), rule);

const fmtDay = (s) => {
  if (!s) return "";
  const [y, m, d] = String(s).slice(0, 10).split("-");
  return `${Number(m)}/${Number(d)}/${y}`;
};

/**
 * The rule for a pipeline row. The calendar outranks the stage: a job with an
 * install booked is scheduled whatever its stage still says (stages lag), so
 * the scheduled and in-production buckets decide first, then the stage, and
 * null when nothing fits.
 */
export function ruleFor(row) {
  if (row?.bucket === "scheduled") {
    return { key: "scheduled", owner: OWNERS.production,
      action: `Production confirms crew and materials the week before the ${row.scheduledDate ? fmtDay(row.scheduledDate) + " " : ""}install.` };
  }
  if (row?.bucket === "inProduction") {
    return { key: "in_production", owner: OWNERS.production, action: "Production tracks the job to completion and books the final walk-through." };
  }
  const byStage = RULE_BY_STAGE.get(stageKey(row?.stage));
  if (byStage) return { key: byStage.key, owner: byStage.owner, action: byStage.action(row) };
  return null;
}

/** Only these buckets are worth a model call; the rest are settled by the rule alone. */
export const MODEL_BUCKETS = new Set(["unscheduled", "awaitingPayment"]);
export const needsModel = (row) => MODEL_BUCKETS.has(row?.bucket);

/**
 * What the model is told about a job: the facts that bear on the next step,
 * nothing volatile (no timestamps, no ids), so the same situation hashes the
 * same and a job is not re-sent every night.
 */
export function suggestionFacts(row, rule = ruleFor(row)) {
  return {
    customer: row.customer ?? null,
    jobNumber: row.jobNumber ?? null,
    stage: row.stage ?? null,
    status: row.bucket,
    contractValue: row.contract ?? null,
    noContractValue: !!row.noContractValue,
    soldDate: row.contractSignedDate ? String(row.contractSignedDate).slice(0, 10) : null,
    daysSinceSold: days(row),
    scheduledInstall: row.scheduledDate ?? null,
    trade: row.trades ?? row.division ?? null,
    salesRep: row.rep ?? null,
    blocker: row.blocker ?? null,
    blockerWrittenByTeam: row.blockerDerived === false,
    owner: row.owner ?? null,
    rule: rule ? { key: rule.key, action: rule.action, owner: rule.owner } : null,
  };
}

/** Stable, dependency-free 32-bit FNV-1a of the canonical JSON — same in the browser and on the server. */
export function factsHash(facts, salt = "") {
  const text = salt + canonical(facts);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
function canonical(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
}

export const SUGGESTION_MAX_WORDS = 20;
export const CONFIDENCES = ["high", "medium", "low"];

/**
 * A model reply, checked. Returns `{ suggestion, confidence }` or null when
 * the reply is not a usable one-sentence action. Tolerates code fences and a
 * few words over the limit; rejects anything that is not one short sentence.
 */
export function validateSuggestion(reply) {
  let obj = reply;
  if (typeof reply === "string") {
    const text = reply.replace(/```(?:json)?/gi, "").trim();
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  }
  if (!obj || typeof obj !== "object") return null;
  let s = String(obj.suggestion ?? "").replace(/\s+/g, " ").trim();
  if (s.length < 8 || s.length > 240) return null;
  // One sentence: cut at the first sentence end that is followed by more text.
  const m = s.match(/^(.+?[.!?])\s+\S/);
  if (m) s = m[1];
  if (s.split(" ").length > SUGGESTION_MAX_WORDS + 5) return null;
  if (!/[.!?]$/.test(s)) s += ".";
  const confidence = CONFIDENCES.includes(obj.confidence) ? obj.confidence : "medium";
  return { suggestion: s, confidence };
}

/** The managers' standing instructions, until they write their own. */
export const DEFAULT_INSTRUCTIONS = `You suggest the single next action for a sold roofing job that has not been built yet. Allied Roofing, New Jersey.

Priorities, in order:
1. Money first: a missing deposit or an unfinished financing application blocks everything. The sales rep who sold the job owns it.
2. Insurance claims: after 30 days pending, the rep calls the adjuster directly rather than waiting.
3. Handoff: a job sitting in "Install Accepted -> SUBMIT SS" for more than a week means the sold sheet is late. The rep submits it; the sales manager chases the rep.
4. Reviews: anything in Sales Review or Production Review over 5 days is escalated to the manager who owns that review.
5. Approved but not on the calendar: production books it and confirms the date with the customer the same day.

Rules for your answer:
- Start with WHO does it (Sales rep, Sales manager, Production, Office).
- One concrete step that can be done today. Not a plan, not a list.
- If the team has written a blocker, take it as true and suggest the step that clears it.
- If the job has no contract value in JobProgress, say the office enters the price before anything else.
- Never suggest cancelling a job or contacting the customer about price. Never invent facts.`;
