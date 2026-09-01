// Parsing of JobProgress appointment result forms.
//
// JobProgress captures the appointment outcome through a result form whose
// answers are free text — the "Was it 2-Legs?" question holds strings like
// "2legs", "2 legs. products showed", "2legs/1st: 20k, 2nd: 19k". This module
// is the single place those strings are interpreted, so the sync (which stores
// the parsed answer) and any UI (which may re-display the raw text) agree.
//
// Shared-package rules apply: no framework, no environment, imports nothing.

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase().replace(/\s+/g, " "));

export const TWO_LEG = "two_leg";
export const ONE_LEG = "one_leg";
/** Non-empty text that names neither answer (or ambiguously names both). */
export const OTHER = "other";

// A leg count must stand alone: "(2|two) legs" with optional hyphen/space.
// The left guard rejects digits inside larger numbers ("21 legs"), and the
// required "leg" word rejects ordinals ("1st: 20k").
const TWO_RE = /(?:^|[^0-9a-z])(?:2|two)\s*-?\s*legs?\b/;
const ONE_RE = /(?:^|[^0-9a-z])(?:1|one)\s*-?\s*legs?\b/;

/**
 * Normalizes a free-text 2-legs answer to two_leg | one_leg | other.
 * Returns null for blank input: an absent answer is missing data, not "other".
 * Text naming both answers is "other" — an ambiguous string must never move a
 * rate in either direction.
 */
export function parseTwoLegAnswer(text) {
  const t = norm(text);
  if (!t) return null;
  const two = TWO_RE.test(t);
  const one = ONE_RE.test(t);
  if (two && one) return OTHER;
  if (two) return TWO_LEG;
  if (one) return ONE_LEG;
  return OTHER;
}

/**
 * Finds the 2-legs question on a result form (an array of {name, value}
 * fields) and returns its raw value, or null when the form lacks the question
 * — which is common: only 42 of 73 filled August forms carried it.
 */
export function findTwoLegField(fields) {
  if (!Array.isArray(fields)) return null;
  for (const field of fields) {
    if (!field || typeof field !== "object") continue;
    const name = norm(field.name);
    if (!name) continue;
    if (TWO_RE.test(name)) {
      return field.value == null ? null : String(field.value);
    }
  }
  return null;
}

/**
 * Reads the result option's group name — JobProgress's own Sale / No Sale /
 * Follow-Up / None taxonomy. Tolerates both the `.data`-wrapped include shape
 * and a plain object.
 */
export function resultGroupName(resultOption) {
  if (!resultOption || typeof resultOption !== "object") return null;
  let group = resultOption.group;
  if (group && typeof group === "object" && "data" in group) group = group.data;
  if (!group || typeof group !== "object") return null;
  const name = group.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}
