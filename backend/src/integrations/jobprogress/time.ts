/**
 * JobProgress timestamps → the office's clock.
 *
 * The API emits every timestamp in UTC, as `YYYY-MM-DD HH:MM:SS` or with a `T`
 * separator, never with an offset. The appointment sync used to slice the date
 * and time straight out of that string, so a 5 PM Eastern estimate was stored
 * as 21:00 (and after the autumn clock change a 7 PM one would have landed on
 * the next day). Everything that turns an API timestamp into a calendar date
 * or wall-clock time for people goes through here.
 */

/** The office runs on Eastern time; appointments are booked and kept in it. */
export const OFFICE_TIMEZONE = "America/New_York";

const API_TS = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Parses an API timestamp as UTC (an explicit offset, if ever present, is honoured). */
export function parseApiUtc(value: unknown): Date | null {
  if (value == null) return null;
  const m = API_TS.exec(String(value).trim());
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}${m[7] ? m[7] : "Z"}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: OFFICE_TIMEZONE, hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});

/** Calendar date (YYYY-MM-DD) and wall-clock time (HH:MM) of an instant in the office's zone. */
export function officeDateTime(at: Date): { date: string; time: string } {
  const p: Record<string, string> = {};
  for (const part of PARTS.formatToParts(at)) p[part.type] = part.value;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * An API timestamp → { at, date, time } on the office's clock, or null when
 * the value is missing or unparseable.
 */
export function apiTimestampToOffice(value: unknown): { at: Date; date: string; time: string } | null {
  const at = parseApiUtc(value);
  return at ? { at, ...officeDateTime(at) } : null;
}
