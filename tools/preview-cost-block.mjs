// Read-only preview of the estimate / GP block (SHEET_COST_TOTALS) on the live tab.
// Plans a push with the block on and prints what it WOULD write. Writes nothing.
//   docker exec -i $(docker ps -q -f name=backend) node --input-type=module < tools/preview-cost-block.mjs
const { GoogleSheetsClient, a1 } = await import("./dist/integrations/google/sheets.js");
const { sheetPushSettings, pushWeeks } = await import("./dist/production/sheetPush.js");
const { planSheet, bringsMoney, colIndex, colLetter } = await import("./dist/production/sheetPlan.js");
const { weeklyJobSheetAsService } = await import("./dist/production/weeklyJobSheet.js");

const s = sheetPushSettings(), c = GoogleSheetsClient.fromEnv();
const now = new Date();
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
const feed = await weeklyJobSheetAsService();
const rows = feed.rows.filter(bringsMoney);
const weeks = pushWeeks(rows, today, s.weeksBack, s.weeksAhead, s.splitFrom);
const grid = await c.getValues(a1(s.tab, "A1:HZ"));
const opts = { now, today, allRows: rows, syncedAt: feed.sync?.finishedAt ?? null, lockWeeks: s.lockWeeks, removeEmptyStale: s.removeEmptyStale };
const off = planSheet(grid, weeks, { ...opts, costTotals: false });
const on = planSheet(grid, weeks, { ...opts, costTotals: true, commission: process.env.COMMISSION !== "false" });

console.log("COST BLOCK:", JSON.stringify(on.summary.costBlock));
{
  // Commission columns: one job row and one total row, as they would be written.
  const cw = on.ops.flatMap((o) => (o.type === "write" ? o.cells : []));
  const cols = ["BV", "BW", "BX", "BY", "BZ", "CA"].map(colIndex);
  const heads = cw.filter((x) => x.row === 0 && cols.includes(x.col)).map((x) => `${colLetter(x.col)}1="${x.value}"`);
  console.log("Commission headings to create:", heads.join(", ") || "(none, already there)");
  const sample = cw.find((x) => x.col === colIndex("BW") && x.row > 0 && String(on.grid[x.row]?.[colIndex("HU")] ?? "") !== "");
  if (sample) for (const L of ["BW", "BY", "BZ", "CA"]) { const w = cw.find((x) => x.row === sample.row && x.col === colIndex(L)); if (w) console.log(`  job row ${sample.row + 1} ${L}: =${w.value.formula}`); }
}
console.log(`Rows removed: off ${off.summary.jobsRemoved}, on ${on.summary.jobsRemoved} (on may remove stale rows that only held estimates)`);
const COLS = ["AV", "AX", "AY", "BD", "BH", "BI", "BJ", "BL", "BN", "BO"].map(colIndex);
const writes = on.ops.flatMap((o) => (o.type === "write" ? o.cells : [])).filter((x) => COLS.includes(x.col));
const g = on.grid;
const label = (r) => String(g[r]?.[0] ?? "");
const totals = [...new Set(writes.map((w) => w.row))].filter((r) => /^(weekly total|cumulative|[a-z]+ \d{4} — )/i.test(label(r))).sort((a, b) => a - b);
console.log(`\nCells in AV/AX/AY/BD/BH-BL/BN/BO: ${writes.length}; total rows: ${totals.length}\n`);
const short = (f) => (f && typeof f === "object" ? "=" + f.formula : String(f)).slice(0, 160);
for (const r of totals) {
  console.log(`row ${r + 1} | ${label(r).slice(0, 60)}`);
  for (const L of ["AV", "BN"]) { const w = writes.find((x) => x.row === r && x.col === colIndex(L)); if (w) console.log(`   ${L}: ${short(w.value)}${short(w.value).length >= 160 ? "…" : ""}`); }
}
const jr = writes.find((w) => !totals.includes(w.row));
if (jr) console.log(`\nexample job row ${jr.row + 1} (${label(jr.row).slice(0, 50)}) ${colLetter(jr.col)}: ${short(jr.value)}…`);
process.exit(0);
