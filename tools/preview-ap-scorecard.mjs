// Read-only preview of [AUTOMATION]AP WEEKLY SCORECARD: what it WOULD write, week by week. Writes nothing.
//   docker exec -i $(docker ps -q -f name=backend) node --input-type=module < tools/preview-ap-scorecard.mjs
const { pushApScorecard } = await import("./dist/production/apScorecard.js");
const r = await pushApScorecard({ dryRun: true });
console.log(`STATUS: ${r.status}${r.reason ? ` (${r.reason})` : ""}  tab: ${r.tab}  live area from row ${(r.startRow ?? 0) + 1}, ${r.rows ?? 0} rows`);
if (r.plan) {
  const money = (v) => (typeof v === "number" ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : v && typeof v === "object" ? "(formula)" : "");
  const day = (v) => (typeof v === "number" ? new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(5, 10) : "");
  const show = new Set(["sub", "mat", "fix", "cart", "op", "arHead", "compare", "week"]);
  for (const row of r.plan.rows) {
    if (!show.has(row.kind)) continue;
    const c = row.cells;
    if (row.kind === "week") { console.log(`\n=== ${c[0]}`); continue; }
    if (row.kind === "op") { console.log(`   payroll  ${String(c[2]).padEnd(22)} ${money(c[3])}`); continue; }
    if (row.kind === "arHead" || row.kind === "compare") { console.log(`   ${String(c[0]).padEnd(40)} ${money(c[3])}  ${String(c[12] ?? "").slice(0, 110)}`); continue; }
    console.log(`   ${row.kind.padEnd(4)} ${day(c[0]).padEnd(5)} ${String(c[1] ?? "").slice(0, 52).padEnd(52)} ${String(c[2] ?? "").slice(0, 18).padEnd(18)} ${money(c[3]).padStart(12)} ${String(c[5] ?? "").padEnd(3)} ${String(c[7] ?? "").slice(0, 28)}${c[12] ? "  | " + String(c[12]).slice(0, 70) : ""}`);
  }
  console.log("\nWEEK SUMMARY (automated vs Pema's tab, before PAID lines are taken out):");
  for (const w of r.weeks ?? []) console.log(`  ${w.monday}: subs ${money(w.subs)} · materials ${money(w.materials)} · carting ${money(w.carting)} · fixed ${money(w.fixed)} · total ${money(w.ours)} · Pema ${w.pema === null ? "-" : money(w.pema)}`);
}
process.exit(0);
