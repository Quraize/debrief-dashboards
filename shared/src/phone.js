// Phone numbers as a matching key.
//
// Every system we touch writes numbers differently — JobProgress stores what
// the call center typed ("(201) 555-0134", "201.555.0134", "+1 201 555 0134"),
// the phone system reports E.164 ("+12015550134"), a spreadsheet import might
// have "2015550134 x2". A call is matched to a lead by comparing KEYS, never
// raw strings: the ten national digits of a North American number, with the
// country code and any extension stripped.

/** Digits only, extension (x123 / ext. 12) removed. */
function digits(raw) {
  const s = String(raw ?? "").replace(/\s*(x|ext\.?|extension)\s*\d+\s*$/i, "");
  return s.replace(/\D/g, "");
}

/**
 * The ten-digit key of a North American number, or null when the input is not
 * one (too short, too long after stripping a leading 1, or a non-NANP code).
 */
export function phoneKey(raw) {
  let d = digits(raw);
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  // NANP: area code and exchange cannot start with 0 or 1.
  if (/^[01]/.test(d) || /^[01]/.test(d.slice(3, 4))) return null;
  return d;
}

/** "(201) 555-0134" for display; the input echoed back when it is not a key. */
export function formatPhone(raw) {
  const k = phoneKey(raw);
  return k ? `(${k.slice(0, 3)}) ${k.slice(3, 6)}-${k.slice(6)}` : String(raw ?? "").trim();
}

/** Distinct keys from a list of raw numbers, in first-seen order. */
export function phoneKeys(raws) {
  const out = [];
  for (const r of raws ?? []) {
    const k = phoneKey(r);
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}
