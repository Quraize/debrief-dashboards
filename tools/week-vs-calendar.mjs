// Read-only: every production-calendar entry in a week, and whether its job is
// on the Weekly Job Sheet that week, with the reason when it is not.
//   docker exec -i -e FROM=2026-10-12 -e TO=2026-10-18 $(docker ps -q -f name=backend) node --input-type=module < tools/week-vs-calendar.mjs
const { withServiceRole } = await import("./dist/db/client.js");
const { weeklyJobSheetAsService } = await import("./dist/production/weeklyJobSheet.js");
const { firstInstallDay, bringsMoney } = await import("./dist/production/sheetPlan.js");
const INSTALL = ["RR", "SR", "RR+SR", "GUTTERS", "WR", "SOLAR", "SHED", "TPO"]; // shared/src/production.js INSTALL_CODES
const isInstallCode = (c) => INSTALL.includes(String(c ?? "").trim().toUpperCase().replace(/\s+/g, "").replace("/", "+"));

const FROM = process.env.FROM || "2026-10-12", TO = process.env.TO || "2026-10-18";
const TZ = "America/New_York";

const entries = await withServiceRole(async (c) => (await c.query(
  `SELECT s.jp_job_id, s.title, s.job_type_code AS code, (s.start_at AT TIME ZONE $3)::date::text AS day, s.is_completed
     FROM jp_schedule s
    WHERE s.deleted_at IS NULL AND (s.start_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
    ORDER BY s.start_at`, [FROM, TO, TZ])).rows, "week-vs-calendar", { quiet: true });

const sheet = await weeklyJobSheetAsService();
const byJob = new Map(sheet.rows.map((r) => [r.jobId, r]));
const jobInfo = await withServiceRole(async (c) => new Map((await c.query(
  `SELECT jp_job_id, current_stage, stage_seen_at IS NOT NULL AS tracked FROM jp_job WHERE jp_job_id = ANY($1::text[])`,
  [[...new Set(entries.map((e) => e.jp_job_id).filter(Boolean))]])).rows.map((r) => [r.jp_job_id, r])), "week-vs-calendar:jobs", { quiet: true });

const money = (n) => (n === null || n === undefined ? "no amount" : `$${Number(n).toLocaleString("en-US")}`);
const on = [], off = [];
const seen = new Set();
for (const e of entries) {
  const key = e.jp_job_id ?? e.title;
  if (seen.has(key)) continue; seen.add(key);
  const days = entries.filter((x) => (x.jp_job_id ?? x.title) === key).map((x) => `${x.day.slice(5)} ${x.code ?? "?"}`).join(", ");
  const r = e.jp_job_id ? byJob.get(e.jp_job_id) : null;
  let reason = null;
  if (!e.jp_job_id) reason = "calendar entry is not linked to a JobProgress job";
  else if (!r) {
    const j = jobInfo.get(e.jp_job_id);
    reason = !j ? "job not in our JobProgress copy" : `job's stage "${j.current_stage ?? "?"}" is not one the sheet follows`;
  } else {
    const first = firstInstallDay(r);
    const weekInstall = entries.some((x) => x.jp_job_id === e.jp_job_id && isInstallCode(x.code));
    if (!weekInstall) reason = "only non-install visits this week (service, repair, punch list, inspection…)";
    else if (first < FROM) reason = `install started earlier, on ${first} (counted in that week)`;
    else if (!bringsMoney(r)) reason = "$0 contract (no money, no row)";
  }
  const line = `${(r?.label ?? e.title ?? "?").slice(0, 70)} | ${days} | ${money(r?.totalRev ?? r?.gross)}`;
  (reason ? off : on).push(reason ? `${line}\n      WHY: ${reason}` : line);
}
console.log(`\nCalendar ${FROM}..${TO}: ${seen.size} jobs\n\nON THE SHEET (${on.length}):\n  ${on.join("\n  ") || "(none)"}`);
console.log(`\nON THE CALENDAR BUT NOT ON THE SHEET THIS WEEK (${off.length}):\n  ${off.join("\n  ") || "(none)"}`);
process.exit(0);
