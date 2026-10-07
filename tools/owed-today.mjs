// Read-only: everyone who owes Allied money right now, largest balance first.
// Same feed and Balance Owed (AB) as the [AUTOMATION]WEEKLY JOB SHEET.
// Run on the server inside the backend container:
//   docker exec -i $(docker ps -q -f name=backend) node --input-type=module < tools/owed-today.mjs
const { weeklyJobSheetAsService } = await import("./dist/production/weeklyJobSheet.js");
const { firstInstallDay } = await import("./dist/production/sheetPlan.js");
const { withServiceRole } = await import("./dist/db/client.js");
const { isCompletedStage } = await import("@allied/shared/jobStages");
const { isStartedStage } = await import("@allied/shared/revenueAr");
const { isDisqualifiedStage } = await import("@allied/shared/leadFlow");

const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
const feed = await weeklyJobSheetAsService();
const extra = await withServiceRole(async (c) => {
  const pay = (await c.query(`SELECT jp_job_id, max(payment_date)::text AS last, count(*)::int AS n
                                FROM jp_job_payment WHERE deleted_at IS NULL AND NOT canceled GROUP BY jp_job_id`)).rows;
  const inv = (await c.query(`SELECT jp_job_id, string_agg(coalesce(invoice_number,'?') || ' ' || coalesce(invoice_date::text,'') ||
                                     ' open ' || coalesce(open_balance::text,'?'), '; ' ORDER BY invoice_date) AS inv
                                FROM jp_job_invoice WHERE deleted_at IS NULL AND coalesce(open_balance, total_amount) > 0 GROUP BY jp_job_id`)).rows;
  const note = (await c.query(`SELECT jp_job_id, owner, next_action, blocker, updated_at::date::text AS at FROM job_pipeline_note`)).rows;
  return { pay: new Map(pay.map((r) => [r.jp_job_id, r])), inv: new Map(inv.map((r) => [r.jp_job_id, r.inv])), note: new Map(note.map((r) => [r.jp_job_id, r])) };
}, "owed-today report (read-only)", { quiet: true });

const money = (n) => "$" + Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dead = (s) => /cancel|lost|declin|dead/i.test(String(s ?? "")) || isDisqualifiedStage(String(s ?? ""));

const rows = feed.rows
  .filter((r) => (Number(r.balanceOwed) || 0) > 0.009 && r.pifStatus !== "YES" && !dead(r.stage))
  .map((r) => {
    const first = firstInstallDay(r);
    const started = (first && first <= today) || isStartedStage(r.stage) || isCompletedStage(r.stage);
    const dep = Number(r.deposit) || 0;
    let type;
    if (isCompletedStage(r.stage)) type = dep > 0 ? "FINAL payment (job complete)" : "FINAL - job complete, NO deposit ever received";
    else if (started) type = dep > 0 ? "PROGRESS payment (job in production)" : "DEPOSIT MISSING - job already started";
    else type = dep > 0 ? "Balance later (deposit in, not started)" : "DEPOSIT DUE before start";
    return { r, first, type };
  })
  .sort((a, b) => Number(b.r.balanceOwed) - Number(a.r.balanceOwed));

let total = 0;
console.log(`OWED TO ALLIED as of ${today} (sheet feed, last sync ${feed.sync?.finishedAt ?? feed.sync?.startedAt ?? "?"})\n`);
rows.forEach(({ r, first, type }, i) => {
  total += Number(r.balanceOwed);
  const p = extra.pay.get(r.jobId), n = extra.note.get(r.jobId);
  const installs = (r.visits ?? []).map((v) => v.day).filter(Boolean).sort();
  console.log(`${i + 1}. ${r.label}  |  OWED ${money(r.balanceOwed)}  |  ${type}`);
  console.log(`   Job # ${r.jobNumber ?? "-"} · Stage: ${r.stage ?? "-"}${r.stageSince ? ` (since ${String(r.stageSince).slice(0, 10)})` : ""} · Rep: ${r.salesRep ?? "-"}`);
  console.log(`   Contract ${money(r.totalRev)} · Deposit ${money(r.deposit)} · Progress ${money(r.progressPayments)} · Paid ${money(r.totalPayments)} · Last payment: ${p?.last ?? "none"}`);
  console.log(`   Install: ${first ?? "not on calendar"}${installs.length ? ` → ${installs.at(-1)}` : ""} · Completed: ${r.completionDate ?? "-"} · Method: ${r.paymentMethod ?? "-"}`);
  console.log(`   Open invoices: ${extra.inv.get(r.jobId) ?? "none in JobProgress"}`);
  if (n) console.log(`   Pipeline note (${n.at}): owner ${n.owner ?? "-"} · next ${n.next_action ?? "-"} · blocker ${n.blocker ?? "-"}`);
  console.log("");
});
console.log(`TOTAL OWED: ${money(total)} across ${rows.length} jobs`);
const mismatch = feed.rows.filter((r) => r.pifStatus && r.pifStatus !== "YES" && r.pifStatus !== "NO" && (Number(r.balanceOwed) || 0) > 0);
if (mismatch.length) {
  console.log(`\nCHECK (stage says paid, ledger still shows a balance):`);
  mismatch.forEach((r) => console.log(`- ${r.label}  ${money(r.balanceOwed)}  stage ${r.stage}`));
}
process.exit(0);
