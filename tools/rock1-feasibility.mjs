// Read-only feasibility check for Rock 1 (Boomerang Revenue Engine).
//   1. How big is each outbound bucket in our data, and how many can we reach?
//   2. What sequences (workflows) does Boomerang already have?
//   3. Can JobProgress carry a campaign source, so campaign appointments are measurable?
// Counts and categories only: no customer names, phones or emails.
//   docker exec -i $(docker ps -q -f name=backend) node --input-type=module < tools/rock1-feasibility.mjs
const { withServiceRole } = await import("./dist/db/client.js");
const head = (t) => console.log(`\n\n######## ${t}`);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "0%");

// Jobs, debriefs and appointments joined the way the dashboards join them.
const JOB_OF_DEBRIEF = `(j.jp_job_id = d.crm_job_id OR (j.job_number IS NOT NULL AND lower(trim(d.crm_lead_id)) = lower(trim(j.job_number))))`;
const SOLD = `(j2.contract_signed_date IS NOT NULL)`;

await withServiceRole(async (db) => {
  const q = async (label, sql) => {
    try { return (await db.query(sql)).rows; }
    catch (e) { console.log(`  [${label}] query failed: ${e.message}`); return []; }
  };

  head("1. OUTBOUND BUCKETS (distinct customers; 'reachable' = has a phone in JobProgress)");
  // Each bucket returns customer ids; reach + overlap are worked out after.
  const buckets = {
    "Resets (reset needed, last 180 days, not rebooked, not sold)": `
      SELECT DISTINCT j.jp_customer_id AS c FROM debrief d JOIN jp_job j ON ${JOB_OF_DEBRIEF}
       WHERE d.appointment_date > current_date - 180 AND j.jp_customer_id IS NOT NULL
         AND (d.reset_needed IS TRUE OR d.appointment_outcome IN ('No Demo — Reset Needed', 'No C / No Show — Reset Needed'))
         AND NOT EXISTS (SELECT 1 FROM jp_appointment a WHERE a.jp_customer_id = j.jp_customer_id AND a.appointment_date > d.appointment_date AND a.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM jp_job j2 WHERE j2.jp_customer_id = j.jp_customer_id AND ${SOLD})`,
    "Cancelled before appointment (last 180 days, not rebooked, not sold)": `
      SELECT DISTINCT j.jp_customer_id AS c FROM debrief d JOIN jp_job j ON ${JOB_OF_DEBRIEF}
       WHERE d.appointment_date > current_date - 180 AND j.jp_customer_id IS NOT NULL
         AND d.appointment_outcome = 'Cancelled Before Appointment'
         AND NOT EXISTS (SELECT 1 FROM jp_appointment a WHERE a.jp_customer_id = j.jp_customer_id AND a.appointment_date > d.appointment_date AND a.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM jp_job j2 WHERE j2.jp_customer_id = j.jp_customer_id AND ${SOLD})`,
    "Unsold demos, from debriefs (Demo No Sale, last 365 days, not sold since)": `
      SELECT DISTINCT j.jp_customer_id AS c FROM debrief d JOIN jp_job j ON ${JOB_OF_DEBRIEF}
       WHERE d.appointment_date > current_date - 365 AND j.jp_customer_id IS NOT NULL
         AND d.appointment_outcome LIKE 'Demo Completed — Demo No Sale%'
         AND NOT EXISTS (SELECT 1 FROM jp_job j2 WHERE j2.jp_customer_id = j.jp_customer_id AND ${SOLD})`,
    "Unsold appointments, from JobProgress results (No Sale, 2026, not sold since)": `
      SELECT DISTINCT a.jp_customer_id AS c FROM jp_appointment a
       WHERE a.appointment_date >= '2026-01-01' AND a.deleted_at IS NULL AND a.jp_customer_id IS NOT NULL
         AND a.result_group ILIKE 'no sale%'
         AND NOT EXISTS (SELECT 1 FROM jp_job j2 WHERE j2.jp_customer_id = a.jp_customer_id AND ${SOLD})`,
    "Past customers (signed a job more than 6 months ago)": `
      SELECT DISTINCT j.jp_customer_id AS c FROM jp_job j
       WHERE j.contract_signed_date < current_date - 183 AND j.jp_customer_id IS NOT NULL AND NOT j.is_insurance`,
    "Leads never booked (customer created in the last 365 days, no appointment, nothing sold)": `
      SELECT cu.jp_customer_id AS c FROM jp_customer cu
       WHERE cu.jp_created_at > now() - interval '365 days'
         AND NOT EXISTS (SELECT 1 FROM jp_appointment a WHERE a.jp_customer_id = cu.jp_customer_id AND a.deleted_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM jp_job j2 WHERE j2.jp_customer_id = cu.jp_customer_id AND ${SOLD})`,
  };
  const phones = new Set((await q("phones", `SELECT DISTINCT jp_customer_id FROM jp_customer_phone`)).map((r) => r.jp_customer_id));
  const all = new Set(), seen = new Set();
  for (const [name, sql] of Object.entries(buckets)) {
    const ids = (await q(name, sql)).map((r) => r.c).filter(Boolean);
    const reach = ids.filter((c) => phones.has(c)).length;
    const fresh = ids.filter((c) => !seen.has(c)); fresh.forEach((c) => seen.add(c)); ids.forEach((c) => all.add(c));
    console.log(`- ${name}: ${ids.length} customers · reachable ${reach} (${pct(reach, ids.length)}) · not already in a bucket above ${fresh.length}`);
  }
  const allReach = [...all].filter((c) => phones.has(c)).length;
  console.log(`\nAll buckets together (each customer once): ${all.size} · reachable ${allReach} (${pct(allReach, all.size)})`);

  const outcomes = await q("outcomes", `SELECT appointment_outcome AS o, count(*)::int n, min(appointment_date)::text first, max(appointment_date)::text last FROM debrief GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`\nDebrief history behind the buckets (first..last date): ${outcomes.map((r) => `${r.o ?? "(blank)"} ${r.n} [${r.first}..${r.last}]`).join(" | ")}`);
  const results = await q("results", `SELECT coalesce(result_group, '(none)') g, count(*)::int n FROM jp_appointment WHERE deleted_at IS NULL AND appointment_date >= '2026-01-01' GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`JobProgress appointment results in 2026: ${results.map((r) => `${r.g} ${r.n}`).join(" | ")}`);
  const stages = await q("stages", `SELECT current_stage s, count(*)::int n FROM jp_job GROUP BY 1 ORDER BY 2 DESC LIMIT 30`);
  console.log(`JobProgress job stages (top 30): ${stages.map((r) => `${r.s} ${r.n}`).join(" | ")}`);

  head("3. CAN JOBPROGRESS CARRY A CAMPAIGN SOURCE?");
  const src = await q("sources", `SELECT referred_by_type t, referred_by_name s, count(*)::int n FROM jp_customer
                                   WHERE coalesce(referred_by_type, '') <> 'customer' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`);
  console.log(`Customer "referred by" sources in JobProgress (top 25): ${src.map((r) => `${r.s ?? "(blank)"} [${r.t ?? "-"}] ${r.n}`).join(" | ")}`);
  const recentSrc = await q("recent sources", `SELECT count(*)::int n, count(*) FILTER (WHERE coalesce(referred_by_name, '') <> '')::int with_src FROM jp_customer WHERE jp_created_at > now() - interval '90 days'`);
  console.log(`New customers in 90 days with a source filled: ${recentSrc[0]?.with_src ?? "?"} of ${recentSrc[0]?.n ?? "?"} (${pct(recentSrc[0]?.with_src, recentSrc[0]?.n)})`);
  const apptKeys = await q("appt keys", `SELECT k, count(*)::int n FROM (SELECT jsonb_object_keys(raw) k FROM jp_appointment WHERE appointment_date > current_date - 90) x
                                          WHERE k ~* 'source|campaign|type|tag|custom|label|category' GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`Appointment fields that could carry a campaign: ${apptKeys.map((r) => `${r.k} (${r.n})`).join(", ") || "(none)"}`);
  const jobKeys = await q("job keys", `SELECT k, count(*)::int n FROM (SELECT jsonb_object_keys(raw) k FROM jp_job WHERE jp_updated_at > now() - interval '90 days') x
                                        WHERE k ~* 'source|campaign|tag|custom|flag|label|lead' GROUP BY 1 ORDER BY 2 DESC`);
  console.log(`Job fields that could carry a campaign: ${jobKeys.map((r) => `${r.k} (${r.n})`).join(", ") || "(none)"}`);
  const flags = await q("flags", `SELECT f->>'title' AS t, count(*)::int n FROM jp_job, jsonb_array_elements(coalesce(raw->'flags'->'data', '[]'::jsonb)) f GROUP BY 1 ORDER BY 2 DESC LIMIT 15`);
  if (flags.length) console.log(`Job flags in use: ${flags.map((r) => `${r.t} ${r.n}`).join(" | ")}`);
}, "rock1 feasibility (read-only)", { quiet: true });

// ── 2. Boomerang sequences ──────────────────────────────────────────────────
head("2. BOOMERANG WORKFLOWS (the sequences a list can be fed into)");
const T = process.env.BOOMERANG_API_TOKEN, L = process.env.BOOMERANG_LOCATION_ID;
const H = { Authorization: `Bearer ${T}`, Version: "2021-07-28", Accept: "application/json" };
const get = async (p) => { const r = await fetch(`https://services.leadconnectorhq.com${p}`, { headers: H }); return r.ok ? r.json() : { error: `HTTP ${r.status}` }; };
const wf = await get(`/workflows/?locationId=${L}`);
if (wf.error) console.log(`Workflows: ${wf.error} (is View Workflows on the integration?)`);
else {
  const list = wf.workflows ?? [];
  console.log(`${list.length} workflows · ${list.filter((w) => w.status === "published").length} published`);
  const groups = { "Reset / no-show": /reset|no.?see|no.?show/i, "Rehash / unsold": /rehash|no.?sale|demo|estimate|expired/i, "Reactivation / past customers": /reactivat|past|review|referral|anniversar/i, "Speed to lead / new leads": /speed|new lead|inbound|missed call|web|form/i };
  const used = new Set();
  for (const [g, re] of Object.entries(groups)) {
    const hit = list.filter((w) => re.test(w.name));
    hit.forEach((w) => used.add(w.id));
    console.log(`\n${g} (${hit.length}):\n  ${hit.map((w) => `${w.name} [${w.status}]`).join("\n  ") || "(none)"}`);
  }
  console.log(`\nOther (${list.length - used.size}):\n  ${list.filter((w) => !used.has(w.id)).map((w) => `${w.name} [${w.status}]`).join("\n  ")}`);
}
const users = await get(`/users/?locationId=${L}`);
console.log(users.error ? `\nUsers: ${users.error}` : `\nBoomerang users: ${(users.users ?? []).map((u) => `${u.name || u.firstName} [${u.roles?.role ?? "?"}]`).join("; ")}`);
process.exit(0);
