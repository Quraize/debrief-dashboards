// The single definition of "this appointment is not a sales opportunity".
//
// ── Why this module exists ──
//
// These keywords previously lived in four places that had drifted apart. Only 6
// of 19 keywords appeared in all four, so the same appointment could be excluded
// from the import, counted by the KPI engine, and bucketed differently again by
// the CRM sync. `ROOF INSPECTION EST` was non-sales to three of them and a
// perfectly good sales appointment to the fourth.
//
// The cause was written in the old code: "The backend cannot import the frontend
// helper, so an equivalent is maintained here." That constraint is gone — this
// package is imported by both sides — so there is one list, here, and nowhere else.
//
// ── How the merged list was chosen ──
//
// Every keyword any implementation excluded is kept, so nothing that used to be
// filtered out silently starts counting. Two entries were dropped as redundant
// rather than as a decision: matching is substring-based, so `warranty` already
// covers `warranty callback`, and `measure` already covers `measurement`.
//
// One keyword is genuinely contested and marked below. It is included to
// preserve today's behaviour, not because the evidence settles it.

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, " "));

/**
 * Titles containing any of these are operational activity, not a sales
 * opportunity: service visits, measurements, installs, deliveries, admin.
 *
 * Matching is substring-based on a normalised (trimmed, lowercased,
 * whitespace-collapsed) title, so `ROOF  INSPECTION EST` matches `inspection`.
 *
 * Adding an entry here removes appointments from every KPI denominator at once.
 * That is the point — but it means an addition is a business decision about what
 * counts as a sales opportunity, not a code tidy-up.
 */
export const NON_SALES_KEYWORDS = [
  // Unanimous across all four previous implementations.
  "sample",
  "walk thru",
  "walk through",
  "customer service",
  "wcb",
  "solar",

  // Spelling variant of the above; neither form is a substring of the other.
  "walkthrough",

  // Operational activity. Present in three of four; the sole dissenter was the
  // 8-keyword copy that nothing ever called.
  "warranty",            // also covers "warranty callback"
  "inspection",
  "measure",             // also covers "measurement"
  "production",
  "collection",
  "material delivery",
  "unassigned",

  // Present in two of four. Neither is a sales visit.
  "install",

  // CONTESTED — one implementation of four, and the only one that is currently
  // live. Retained so this consolidation changes no existing behaviour, but the
  // evidence does not settle it: "warranty" already catches the documented case
  // ("warranty callback"), and a bare "callback" could plausibly appear on a
  // genuine rehash. Worth validating against real appointment titles and then
  // deciding deliberately.
  "callback",
  "call back",

  // Seen on the live calendar (Sep 2026 audit of every sales-type title):
  // office errands booked as appointments, not opportunities.
  "contract signing",
  "site assess",         // "Site Assessment", "Site Assesment"
  "dropping off",        // "DROPPING OFF SUPPLIES"
  "paper work",
  "paperwork",
  "deposit pick",        // "deposit pick up"
  "adjuster",            // "MEET WITH THE ADJUSTER" (insurance)
];

/**
 * True when the title describes non-sales activity.
 * A blank title is NOT treated as non-sales here — callers decide what an
 * absent title means, because the answer differs (see salesAppointment.js).
 */
export function isNonSalesTitle(title) {
  const t = norm(title);
  if (!t) return false;
  return NON_SALES_KEYWORDS.some((keyword) => t.includes(keyword));
}

/**
 * The keyword that caused the exclusion, or null. Used for audit rows and the
 * exclusion reasons shown in the import UI, so a human can see *why* a record
 * was dropped rather than just that it was.
 */
export function nonSalesKeyword(title) {
  const t = norm(title);
  if (!t) return null;
  return NON_SALES_KEYWORDS.find((keyword) => t.includes(keyword)) ?? null;
}

export { norm as normalizeTitle };
