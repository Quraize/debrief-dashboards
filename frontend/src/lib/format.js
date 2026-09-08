/**
 * Display formatting for dates and times the office reads: US dates
 * (MM/DD/YYYY) and 12-hour clock. Storage stays ISO (YYYY-MM-DD, HH:MM).
 */

/** "2026-09-03" or "2026-09-03T14:00:00Z" → "09/03/2026". Anything unparseable is returned as-is. */
export function usDate(value) {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return String(value);
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/** "14:00" or "14:00:00" → "2:00 PM"; "09:05" → "9:05 AM". Anything else is returned as-is. */
export function simpleTime(value) {
  if (!value) return "";
  const m = /^(\d{1,2}):(\d{2})/.exec(String(value).trim());
  if (!m) return String(value);
  const h = Number(m[1]);
  if (h > 23) return String(value);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${m[2]} ${suffix}`;
}
