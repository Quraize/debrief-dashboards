// Read-only discovery of the Boomerang (GoHighLevel white-label) account, so
// we understand it fully before building anything. Prints counts and
// categories only: no customer names, phones or emails, and never the key.
//   docker exec -i $(docker ps -q -f name=backend) node --input-type=module < tools/boomerang-discovery.mjs
const { withServiceRole } = await import("./dist/db/client.js");
const T = process.env.BOOMERANG_API_TOKEN, L = process.env.BOOMERANG_LOCATION_ID, B = "https://services.leadconnectorhq.com";
if (!T || !L) { console.log("BOOMERANG_API_TOKEN / BOOMERANG_LOCATION_ID not visible to the backend."); process.exit(0); }
const H = { Authorization: `Bearer ${T}`, Version: "2021-07-28", Accept: "application/json", "Content-Type": "application/json" };
const DAY = 86400000, now = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(path, init = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(B + path, { headers: H, ...init });
    if (r.status === 429) { await sleep(1500 * (attempt + 1)); continue; }
    const text = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status} ${text.slice(0, 120)}` };
    try { return JSON.parse(text); } catch { return { error: "not JSON" }; }
  }
  return { error: "rate limited" };
}
const tally = (vals, top = 12) => {
  const m = {}; for (const v of vals) m[v] = (m[v] ?? 0) + 1;
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => `${k} ×${n}`).join(" | ") || "(none)";
};
const month = (d) => (d ? new Date(d).toISOString().slice(0, 7) : "?");
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "0%");
const head = (t) => console.log(`\n\n######## ${t}`);
const phoneKey = (p) => { const d = String(p ?? "").replace(/\D/g, "").slice(-10); return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? d : null; };

// ── A. Account ──────────────────────────────────────────────────────────────
head("A. ACCOUNT");
const loc = await api(`/locations/${L}`);
console.log(`Location: ${loc.location?.name ?? loc.error} · timezone ${loc.location?.timezone ?? "?"}`);
const users = await api(`/users/?locationId=${L}`);
const userName = {};
if (users.error) console.log(`Users: ${users.error} (add users.readonly to the integration)`);
else { for (const u of users.users ?? []) userName[u.id] = u.name || `${u.firstName ?? ""} ${u.lastName ?? ""}`.trim(); console.log(`Users (${(users.users ?? []).length}): ${(users.users ?? []).map((u) => `${userName[u.id]} [${u.roles?.role ?? u.roles?.type ?? "?"}]`).join("; ")}`); }
const wf = await api(`/workflows/?locationId=${L}`);
console.log(wf.error ? `Workflows: ${wf.error} (add workflows.readonly)` : `Workflows (${(wf.workflows ?? []).length}): ${tally((wf.workflows ?? []).map((w) => w.status))}\n  ${(wf.workflows ?? []).map((w) => `${w.name} [${w.status}]`).join("\n  ")}`);
const camp = await api(`/campaigns/?locationId=${L}`);
console.log(camp.error ? `Campaigns: ${camp.error}` : `Campaigns (${(camp.campaigns ?? []).length}): ${(camp.campaigns ?? []).map((c) => `${c.name} [${c.status}]`).join("; ")}`);
const cv = await api(`/locations/${L}/customValues`);
console.log(cv.error ? `Custom values: ${cv.error}` : `Custom values (${(cv.customValues ?? []).length}): ${(cv.customValues ?? []).map((c) => c.name).join("; ")}`);

// ── B. Contacts: 6 months, newest first ─────────────────────────────────────
head("B. CONTACTS (created in the last 6 months)");
const fields = (await api(`/locations/${L}/customFields`)).customFields ?? [];
const fname = Object.fromEntries(fields.map((f) => [f.id, f.name.trim()]));
const contacts = []; const since6 = now - 183 * DAY;
for (let page = 1; page <= 60; page++) {
  const r = await api(`/contacts/search`, { method: "POST", body: JSON.stringify({ locationId: L, page, pageLimit: 100, sort: [{ field: "dateAdded", direction: "desc" }] }) });
  if (r.error) { console.log(`contacts search: ${r.error}`); break; }
  const cs = r.contacts ?? []; if (!cs.length) break;
  let older = false;
  for (const c of cs) { if (new Date(c.dateAdded).getTime() >= since6) contacts.push(c); else older = true; }
  if (older) break;
}
const total = await api(`/contacts/?locationId=${L}&limit=1`);
console.log(`All contacts: ${total.meta?.total ?? "?"} · created in 6 months: ${contacts.length}`);
console.log(`Created per month: ${tally(contacts.map((c) => month(c.dateAdded)), 7)}`);
const recent90 = contacts.filter((c) => new Date(c.dateAdded).getTime() >= now - 90 * DAY);
const cf = (c, name) => (c.customFields ?? []).map((x) => (fname[x.id] === name ? String(x.value ?? "").trim() : "")).find(Boolean) || "";
console.log(`\nLast 90 days: ${recent90.length} contacts`);
console.log(`Type: ${tally(recent90.map((c) => c.type || "(blank)"))}`);
console.log(`Lead Source: ${tally(recent90.map((c) => cf(c, "Lead Source") || "(blank)"))}`);
console.log(`Contact source field: ${tally(recent90.map((c) => c.source || "(blank)"))}`);
console.log(`First touch (session source / medium): ${tally(recent90.map((c) => [c.attributionSource?.sessionSource, c.attributionSource?.medium].filter(Boolean).join(" / ") || "(none)"))}`);
console.log(`Last touch: ${tally(recent90.map((c) => [c.lastAttributionSource?.sessionSource, c.lastAttributionSource?.medium].filter(Boolean).join(" / ") || "(none)"))}`);
console.log(`UTM campaign present: ${pct(recent90.filter((c) => c.attributionSource?.utmCampaign || c.attributionSource?.campaign).length, recent90.length)}`);
console.log(`Tags (top 25): ${tally(recent90.flatMap((c) => c.tags ?? []), 25)}`);
console.log(`Do-not-disturb on: ${pct(recent90.filter((c) => c.dnd).length, recent90.length)} · phone: ${pct(recent90.filter((c) => phoneKey(c.phone)).length, recent90.length)} · email: ${pct(recent90.filter((c) => c.email).length, recent90.length)} · address: ${pct(recent90.filter((c) => c.address1).length, recent90.length)}`);
const fill = {}; for (const c of recent90) for (const x of c.customFields ?? []) if (fname[x.id] && String(x.value ?? "").trim()) fill[fname[x.id]] = (fill[fname[x.id]] ?? 0) + 1;
console.log(`Custom fields actually used (last 90 days): ${Object.entries(fill).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, recent90.length)}`).join(" | ") || "(none)"}`);
for (const f of ["Project Trade Selector", "Project Type Selector", "Customer Budget", "Desired Start Date", "Lost Reason Selector", "Invalid Lead Selector", "Appointment Disposiition", "Lead Source Selector"]) {
  const v = recent90.map((c) => cf(c, f)).filter(Boolean); if (v.length) console.log(`  ${f}: ${tally(v, 8)}`);
}

// ── C. Opportunities ────────────────────────────────────────────────────────
head("C. OPPORTUNITIES (all)");
const pipes = (await api(`/opportunities/pipelines?locationId=${L}`)).pipelines ?? [];
const pipeName = Object.fromEntries(pipes.map((p) => [p.id, p.name]));
const stageName = Object.fromEntries(pipes.flatMap((p) => (p.stages ?? []).map((s) => [s.id, s.name.trim()])));
const opps = []; let afterId = "", after = "";
for (let i = 0; i < 80; i++) {
  const r = await api(`/opportunities/search?location_id=${L}&limit=100${afterId ? `&startAfterId=${afterId}&startAfter=${after}` : ""}`);
  if (r.error) { console.log(`opportunities: ${r.error}`); break; }
  opps.push(...(r.opportunities ?? []));
  afterId = r.meta?.startAfterId ?? ""; after = r.meta?.startAfter ?? "";
  if (!afterId || !(r.opportunities ?? []).length) break;
}
console.log(`Opportunities read: ${opps.length}`);
for (const p of pipes) {
  const list = opps.filter((o) => o.pipelineId === p.id); if (!list.length) continue;
  const won = list.filter((o) => o.status === "won");
  console.log(`\n${p.name}: ${list.length} · status ${tally(list.map((o) => o.status))}`);
  console.log(`  created per month: ${tally(list.map((o) => month(o.createdAt)), 7)}`);
  console.log(`  moved stage in last 30 days: ${list.filter((o) => o.lastStageChangeAt && now - new Date(o.lastStageChangeAt).getTime() < 30 * DAY).length} · value on won: $${Math.round(won.reduce((n, o) => n + (Number(o.monetaryValue) || 0), 0)).toLocaleString("en-US")} (${won.filter((o) => Number(o.monetaryValue) > 0).length} with a value)`);
  console.log(`  source: ${tally(list.map((o) => o.source || "(blank)"), 8)}`);
  console.log(`  assigned to: ${tally(list.map((o) => (o.assignedTo ? userName[o.assignedTo] || "a user" : "(nobody)")), 8)}`);
}
const contactsWithOpp = new Set(opps.map((o) => o.contactId));
console.log(`\nContacts from the last 90 days with an opportunity: ${pct(recent90.filter((c) => contactsWithOpp.has(c.id)).length, recent90.length)}`);

// ── D. Calendars and appointments ───────────────────────────────────────────
head("D. CALENDARS AND APPOINTMENTS (last 60 days and next 30)");
const cals = (await api(`/calendars/?locationId=${L}`)).calendars ?? [];
for (const c of cals) {
  const ev = await api(`/calendars/events?locationId=${L}&calendarId=${c.id}&startTime=${now - 60 * DAY}&endTime=${now + 30 * DAY}`);
  const list = ev.events ?? [];
  console.log(`- ${c.name} [${c.calendarType ?? c.eventType ?? "?"}${c.isActive === false ? ", inactive" : ""}]: ${ev.error ?? `${list.length} events · past ${list.filter((e) => new Date(e.startTime).getTime() < now).length} · status ${tally(list.map((e) => e.appointmentStatus || e.status || "?"))} · per month ${tally(list.map((e) => month(e.startTime)), 4)}`}`);
}

// ── E. Conversations ────────────────────────────────────────────────────────
head("E. CONVERSATIONS (updated in the last 30 days)");
const convs = []; let last = "";
for (let i = 0; i < 30; i++) {
  const r = await api(`/conversations/search?locationId=${L}&limit=100&sort=desc&sortBy=last_message_date${last ? `&startAfterDate=${last}` : ""}`);
  if (r.error) { console.log(`conversations: ${r.error}`); break; }
  const cs = r.conversations ?? []; if (!cs.length) break;
  let older = false;
  for (const c of cs) { const t = Number(c.lastMessageDate ?? c.dateUpdated); if (t >= now - 30 * DAY) convs.push(c); else older = true; }
  last = cs.at(-1)?.lastMessageDate ?? cs.at(-1)?.sort?.[0] ?? "";
  if (older || !last) break;
}
console.log(`Conversations active in 30 days: ${convs.length}`);
console.log(`Last message type: ${tally(convs.map((c) => c.lastMessageType || c.type || "?"))}`);
console.log(`Last message direction: ${tally(convs.map((c) => c.lastMessageDirection || "?"))} · unread: ${convs.filter((c) => (c.unreadCount ?? 0) > 0).length}`);
// A sample of message threads: what kinds of messages and call outcomes exist.
const sample = convs.slice(0, 40), types = [], callStatus = [], firstReply = [];
for (const c of sample) {
  const m = await api(`/conversations/${c.id}/messages?limit=50`);
  const msgs = m.messages?.messages ?? m.messages ?? [];
  for (const x of msgs) { types.push(`${x.messageType ?? x.type ?? "?"}/${x.direction ?? "?"}`); if (/call/i.test(String(x.messageType ?? ""))) callStatus.push(x.status ?? x.meta?.call?.status ?? "?"); }
  const sorted = [...msgs].sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
  const firstIn = sorted.find((x) => x.direction === "inbound"), reply = firstIn && sorted.find((x) => x.direction === "outbound" && new Date(x.dateAdded) > new Date(firstIn.dateAdded));
  if (firstIn && reply) firstReply.push((new Date(reply.dateAdded) - new Date(firstIn.dateAdded)) / 60000);
}
console.log(`Message kinds (sample of ${sample.length} threads): ${tally(types, 15)}`);
console.log(`Call outcomes in the sample: ${tally(callStatus)}`);
const med = firstReply.sort((a, b) => a - b)[Math.floor(firstReply.length / 2)];
console.log(`Minutes from a customer's first message to our first reply (sample): median ${med === undefined ? "?" : Math.round(med)} over ${firstReply.length} threads`);

// ── F. Forms ────────────────────────────────────────────────────────────────
head("F. FORMS (submissions in the last 90 days)");
const forms = await api(`/forms/?locationId=${L}&limit=50`);
if (forms.error) console.log(`Forms: ${forms.error}`);
else for (const f of forms.forms ?? []) {
  const s = await api(`/forms/submissions?locationId=${L}&formId=${f.id}&limit=1&startAt=${new Date(now - 90 * DAY).toISOString().slice(0, 10)}&endAt=${new Date(now).toISOString().slice(0, 10)}`);
  console.log(`- ${f.name}: ${s.error ?? `${s.meta?.total ?? (s.submissions ?? []).length} submissions`}`);
}

// ── G. Can Boomerang contacts be joined to JobProgress? ─────────────────────
head("G. MATCHING TO JOBPROGRESS");
const keys90 = [...new Set(recent90.map((c) => phoneKey(c.phone)).filter(Boolean))];
const emails90 = [...new Set(recent90.map((c) => String(c.email ?? "").trim().toLowerCase()).filter(Boolean))];
const g = await withServiceRole(async (db) => {
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  return {
    customers: (await q(`SELECT count(*)::int n, count(*) FILTER (WHERE jp_created_at > now() - interval '90 days')::int recent FROM jp_customer`))[0],
    phoneCover: (await q(`SELECT count(DISTINCT cu.jp_customer_id)::int n FROM jp_customer cu JOIN jp_customer_phone p USING (jp_customer_id) WHERE cu.jp_created_at > now() - interval '90 days'`))[0].n,
    phoneRows: (await q(`SELECT count(*)::int n, max(last_seen_at)::text latest FROM jp_customer_phone`))[0],
    phoneHits: (await q(`SELECT count(DISTINCT phone_key)::int n FROM jp_customer_phone WHERE phone_key = ANY($1::text[])`, [keys90]))[0].n,
    rawPhoneHits: (await q(`WITH d AS MATERIALIZED (SELECT regexp_replace(raw::text, '[^0-9]', '', 'g') AS digits FROM jp_customer)
                            SELECT count(*)::int n FROM unnest($1::text[]) k WHERE EXISTS (SELECT 1 FROM d WHERE position(k IN d.digits) > 0)`, [keys90]))[0].n,
    emailHits: (await q(`WITH t AS MATERIALIZED (SELECT lower(raw::text) AS txt FROM jp_customer)
                         SELECT count(*)::int n FROM unnest($1::text[]) e WHERE EXISTS (SELECT 1 FROM t WHERE position('"' || e || '"' IN t.txt) > 0)`, [emails90]))[0].n,
    emailInRaw: (await q(`SELECT count(*) FILTER (WHERE raw::text ILIKE '%@%')::int n, count(*)::int total FROM jp_customer WHERE jp_created_at > now() - interval '90 days'`))[0],
  };
}, "boomerang discovery: JobProgress match check (read-only)", { quiet: true });
console.log(`JobProgress customers: ${g.customers.n} (created in 90 days: ${g.customers.recent})`);
console.log(`Of those recent customers, with a stored phone: ${g.phoneCover} (${pct(g.phoneCover, g.customers.recent)}) · phone rows ${g.phoneRows.n}, last refreshed ${g.phoneRows.latest}`);
console.log(`Boomerang contacts (90 days) with a phone: ${keys90.length}`);
console.log(`  matched on the stored JobProgress phone list: ${g.phoneHits} (${pct(g.phoneHits, keys90.length)})`);
console.log(`  matched anywhere in the JobProgress customer record: ${g.rawPhoneHits} (${pct(g.rawPhoneHits, keys90.length)})`);
console.log(`Boomerang contacts (90 days) with an email: ${emails90.length} · matched to a JobProgress customer by email: ${g.emailHits} (${pct(g.emailHits, emails90.length)}) · recent JobProgress customers with any email: ${pct(g.emailInRaw.n, g.emailInRaw.total)}`);
process.exit(0);
