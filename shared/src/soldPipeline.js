// Sold-Job Pipeline / Unscheduled Work — the production dashboard's number
// one question: of everything we have sold, what is on the calendar, what is
// not, and how much money is that?
//
// The rules, decided 2026-09-23 with the CEO's brief:
//   sold        a job with a signed contract date;
//   in pipeline until it reaches a Paid or later stage (Paid New Roof,
//               Warranty, Client Satisfaction…) — the "leaves at warranty"
//               reading without counting money already banked. Cancelled,
//               lost and disqualified jobs are never pipeline;
//   scheduled   an install visit is booked, or the stage itself says the job
//               is scheduled or in production (the calendar codes for some
//               trades are not yet recognised, and the stage does not lie);
//   week        a multi-day install belongs to the week it STARTS;
//   blocker     read off the stage, until production writes its own.
// Nothing ages off: the unscheduled list sorts oldest first so a job signed
// in 2021 sits at the top where someone has to look at it.

import { stageKey, isPaidStage } from "./jobStages.js";
import { isDisqualifiedStage } from "./leadFlow.js";
import { weekBounds } from "./production.js";

/** Never pipeline: the sale fell through or was never real. */
export const DEAD_STAGE = /cancel|lost|disqualif/i;

/** The job is on the calendar or past it, whatever its visits are coded. */
export const SCHEDULED_STAGES = ["Roof/Siding Scheduled", "Repairs Scheduled", "Remodel Scheduled"];
export const IN_PRODUCTION_STAGES = ["Production Started", "Gutters/Solar/Punchlist", "Need Final Walk-Through", "City & Manufacturer Inspection"];
/** Work done, money open — still pipeline (not yet cash), but not production's queue. */
export const AWAITING_PAYMENT_STAGES = ["COMPLETED NEED FINAL PAYMENT!!", "Collections"];

const keys = (list) => new Set(list.map(stageKey));
const SCHEDULED = keys(SCHEDULED_STAGES), IN_PRODUCTION = keys(IN_PRODUCTION_STAGES), AWAITING_PAYMENT = keys(AWAITING_PAYMENT_STAGES);

/** The blocker the stage implies, for the Blocker column until production overrides it. */
export const STAGE_BLOCKERS = [
  { blocker: "Waiting on deposit / financing", stages: ["Accepted/No Deposit/Finance", "Accepted/Needs Financing"] },
  { blocker: "Insurance claim pending", stages: ["Accepted/INS Claim Pending"] },
  { blocker: "Credit or financing declined — on hold", stages: ["On Hold/Credit DQ (MGR APPR)", "On Hold/Financing Decline"] },
  { blocker: "On hold", stages: ["Project On Hold"] },
  { blocker: "Awaiting sold-sheet handoff to production", stages: ["Install Accepted-> SUBMIT SS", "Repair Accepted-> SUBMIT SS"] },
  { blocker: "In sales review", stages: ["Sales Review"] },
  { blocker: "In production review", stages: ["Production Review"] },
  { blocker: "Approved — not yet on the calendar", stages: ["Approved New Installs", "Approved Service/Repairs"] },
];
const BLOCKER_BY_STAGE = new Map();
for (const b of STAGE_BLOCKERS) for (const s of b.stages) BLOCKER_BY_STAGE.set(stageKey(s), b.blocker);

export const BUCKETS = [
  { key: "unscheduled", label: "Unscheduled", tone: "red" },
  { key: "scheduled", label: "Scheduled", tone: "green" },
  { key: "inProduction", label: "In production", tone: "blue" },
  { key: "awaitingPayment", label: "Completed, awaiting payment", tone: "amber" },
];

/** A missing price stays null — distinct from a job someone priced at zero. */
const num = (v) => { if (v === null || v === undefined || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** A sold job that has not yet left the pipeline. */
export function inPipeline(job) {
  if (!job?.contractSignedDate) return false;
  const stage = String(job.stage ?? "");
  if (DEAD_STAGE.test(stage) || isDisqualifiedStage(stage)) return false;
  return !isPaidStage(stage);
}

/**
 * Which bucket a pipeline job is in, from its stage and its install visits.
 *   awaitingPayment  work done, money open
 *   inProduction     the crew has started (stage), or the first install day is past
 *   scheduled        an install day is booked, or the stage says scheduled
 *   unscheduled      none of the above
 */
export function bucketFor(job, today) {
  const k = stageKey(job.stage);
  if (AWAITING_PAYMENT.has(k)) return "awaitingPayment";
  if (IN_PRODUCTION.has(k)) return "inProduction";
  const first = (job.installDays ?? [])[0] ?? null;
  if (first && today && first < today) return "inProduction";
  if (first || SCHEDULED.has(k)) return "scheduled";
  return "unscheduled";
}

/** Blocker text for a job with no override: from the stage, else the stage name itself. */
export function derivedBlocker(job, bucket) {
  if (bucket === "awaitingPayment") return "Awaiting final payment";
  if (bucket === "inProduction") return "In production";
  if (bucket === "scheduled") return "Scheduled";
  return BLOCKER_BY_STAGE.get(stageKey(job.stage)) ?? (job.stage ? `Stage: ${job.stage}` : "No stage");
}

/** Monday of the week the install starts — the Expected Production Week. */
export function expectedWeek(installDay) {
  return installDay ? weekBounds(installDay).from : null;
}

const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * The whole report.
 * @param {Array<object>} jobs  every sold job the loader found (pipeline or not — this filters)
 *   { jobId, customerId, jobNumber, customer, city, address, stage, contractSignedDate, contract,
 *     installDays: string[] ascending (install-code visits only), rep, note, jpUrl }
 * @param {string} today  YYYY-MM-DD in the office calendar
 */
export function soldPipeline(jobs, today) {
  const thisWeek = weekBounds(today), nextWeek = weekBounds(today, 1);
  const rows = (jobs ?? []).filter(inPipeline).map((j) => {
    const bucket = bucketFor(j, today);
    const first = (j.installDays ?? [])[0] ?? null;
    const next = (j.installDays ?? []).find((d) => d >= today) ?? null;
    const contract = num(j.contract);
    const note = j.note ?? null;
    return {
      ...j,
      contract,
      bucket,
      scheduledDate: first,
      nextInstallDate: next,
      expectedWeek: expectedWeek(first),
      daysSinceSold: daysBetween(String(j.contractSignedDate).slice(0, 10), today),
      blocker: note?.blocker || derivedBlocker(j, bucket),
      blockerDerived: !note?.blocker,
      owner: note?.owner ?? null,
      nextAction: note?.nextAction ?? null,
      noteUpdatedBy: note?.updatedBy ?? null,
      noteUpdatedAt: note?.updatedAt ?? null,
      noContractValue: contract === null || contract <= 0,
    };
  });
  // Oldest sale first: nothing ages off, so the stale ones sit where they are seen.
  rows.sort((a, b) => String(a.contractSignedDate).localeCompare(String(b.contractSignedDate)) || String(a.jobNumber ?? "").localeCompare(String(b.jobNumber ?? "")));

  return { today, thisWeek, nextWeek, totals: pipelineTotals(rows, today), rows };
}

/**
 * The headline numbers for a set of pipeline rows. Separate from the report
 * so a page that has filtered the rows — by sold date, by install date — can
 * show totals for exactly what is on screen. "This week" and "next week" are
 * always the real calendar weeks around `today`, whatever the filter.
 */
export function pipelineTotals(rows, today) {
  const thisWeek = weekBounds(today), nextWeek = weekBounds(today, 1);
  const sum = (list) => Math.round(list.reduce((n, r) => n + (r.contract ?? 0), 0) * 100) / 100;
  const inWeek = (r, w) => r.scheduledDate !== null && r.scheduledDate >= w.from && r.scheduledDate <= w.to;
  const by = Object.fromEntries(BUCKETS.map((b) => [b.key, (rows ?? []).filter((r) => r.bucket === b.key)]));
  rows = rows ?? [];
  return {
      jobs: rows.length,
      totalPipeline: sum(rows),
      unscheduled: sum(by.unscheduled), unscheduledJobs: by.unscheduled.length,
      /** The production manager's question: sold THIS MONTH and still not on the calendar. */
      unscheduledSoldThisMonth: sum(by.unscheduled.filter((r) => String(r.contractSignedDate ?? "").slice(0, 7) === today.slice(0, 7))),
      unscheduledSoldThisMonthJobs: by.unscheduled.filter((r) => String(r.contractSignedDate ?? "").slice(0, 7) === today.slice(0, 7)).length,
      scheduled: sum(by.scheduled), scheduledJobs: by.scheduled.length,
      inProduction: sum(by.inProduction), inProductionJobs: by.inProduction.length,
      awaitingPayment: sum(by.awaitingPayment), awaitingPaymentJobs: by.awaitingPayment.length,
      /** Sold jobs with no production date yet — the CEO's "awaiting production". */
      awaitingProduction: by.unscheduled.length,
      expectedThisWeek: sum(rows.filter((r) => inWeek(r, thisWeek))), expectedThisWeekJobs: rows.filter((r) => inWeek(r, thisWeek)).length,
      expectedNextWeek: sum(rows.filter((r) => inWeek(r, nextWeek))), expectedNextWeekJobs: rows.filter((r) => inWeek(r, nextWeek)).length,
      /** Pipeline jobs whose contract value is missing in JobProgress: every $ figure above is short by these. */
      noContractValue: rows.filter((r) => r.noContractValue).length,
  };
}
