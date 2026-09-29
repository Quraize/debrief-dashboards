/**
 * Production Revenue + AR / Payment Summary — management's cash view.
 *
 * Of the work we started: what it is worth, what has been paid in full, what
 * is still owed, what should arrive this week and next, and what is overdue.
 * Rules and totals come from shared/src/revenueAr.js via
 * GET /api/production/revenue. Two red counts never hide: started jobs with
 * no payment recorded, and Paid stages whose ledger still shows a balance —
 * the platform cannot make cash move, but it can make the gap visible.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { PIPELINE_ROLES } from "@allied/shared/constants";
import { revenueTotals, startedRevenue, expectedCollections, operationalAr, invoicedAr, depositsMissing, STATUSES } from "@allied/shared/revenueAr";
import { REVENUE_DATE_FILTERS, ALL_TIME_FILTER, inDateRange } from "@allied/shared/constants";
import DateRangeFilter from "@/components/DateRangeFilter";
import ScrollTable from "@/components/ScrollTable";
import { Loader2, ExternalLink, Search, ChevronDown, ChevronRight } from "lucide-react";
import { sheetWeekFrom } from "@allied/shared/production";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtWeek = (s) => (s ? "Wk of " + new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : "—");

/** The week filters, as steps through the sheet's blocks from today's. */
const BLOCK_OFFSET = { "This Week": 0, "Last Week": -1, "Next Week": 1 };

const TONE = {
  red: "bg-red-50 text-red-900 border-red-200",
  green: "bg-green-50 text-green-900 border-green-200",
  blue: "bg-blue-50 text-blue-900 border-blue-200",
  amber: "bg-amber-50 text-amber-900 border-amber-200",
  navy: "bg-primary text-primary-foreground border-primary",
  slate: "bg-white text-primary border-border",
};

export default function ProductionRevenue() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && PIPELINE_ROLES.includes(me.role);
  const { data, isLoading, error } = useQuery({ queryKey: ["production-revenue"], queryFn: productionApi.revenue, enabled: allowed, staleTime: 60_000 });
  const [status, setStatus] = useState("all");
  const [flag, setFlag] = useState("");
  const [q, setQ] = useState("");
  // The range always applies to the START date: this is a started-revenue view.
  const [range, setRange] = useState("This Week");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");

  const book = data?.rows ?? [];
  const inRange = useMemo(() => {
    if (range === ALL_TIME_FILTER) return book;
    return book.filter((r) => inDateRange(r.startedDay, range, cs, ce));
  }, [book, range, cs, ce]);
  // Revenue started: the Weekly Job Sheet's jobs, each once, in the week its
  // first install falls in; the date range picks which weeks.
  // This / Last / Next Week are the sheet's blocks: a week that crosses a
  // month end is two weeks here too (on 9/29, This Week is 9/28–9/30).
  const started = useMemo(() => {
    if (!data?.started) return null;
    const { rows: all, splitFrom } = data.started;
    const block = BLOCK_OFFSET[range] === undefined ? null : sheetWeekFrom(data.today, BLOCK_OFFSET[range], splitFrom);
    // One test for "is this day in the period picked", used by every card.
    const inPeriod = (day) => !!day && (range === ALL_TIME_FILTER ? true : block ? day >= block.from && day <= block.to : inDateRange(day, range, cs, ce));
    const list = all.filter((r) => inPeriod(r.firstInstall));
    return { rows: list, block, expected: expectedCollections(all, inPeriod), invoiced: invoicedAr(all, inPeriod, data.today), ...startedRevenue(list, data.today, splitFrom) };
  }, [data, range, cs, ce]);
  // Started / paid / owed follow the range; expected cash and AR are the whole book.
  const t = useMemo(() => (data ? revenueTotals(inRange, data.today, { overdueDays: data.totals.overdueDays }, book) : null), [inRange, book, data]);

  const rows = useMemo(() => {
    let list = inRange;
    if (status !== "all") list = list.filter((r) => r.status === status);
    if (flag === "noPayment") list = list.filter((r) => r.noPayment && r.status !== "paid");
    if (flag === "paidStageOwed") list = list.filter((r) => r.paidStageOwed);
    if (flag === "overdue") list = book.filter((r) => r.overdue);
    if (flag === "ar") list = book.filter((r) => r.status === "completed" && r.owed > 0);
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((r) => [r.customer, r.jobNumber, r.city, r.address, r.stage, r.rep].some((v) => String(v ?? "").toLowerCase().includes(s)));
    return list;
  }, [inRange, book, status, flag, q]);

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Revenue &amp; AR is for managers: admin, sales manager or project manager.</div>;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Production Revenue &amp; AR</h1>
        <p className="text-sm text-muted-foreground max-w-4xl">
          The Weekly Job Sheet&apos;s jobs and numbers. The top half follows the date filter: what <strong>started</strong> in that period,
          what of it is paid in full or still owed, and what should come in. The bottom half is <strong>what customers owe today</strong>,
          whatever period is picked.
        </p>
      </div>

      <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
        filters={REVENUE_DATE_FILTERS} />

      {isLoading || !t ? (
        error ? <p className="text-sm text-red-600">The summary could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {started && <StartedPanel s={started} range={range} today={data.today} />}

          <GroupHeading>For the selected period · {range}{started?.block ? ` (${fmtDay(started.block.from)} – ${fmtDay(started.block.to)})` : ""}</GroupHeading>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {started && (
              <Card tone="green" label="Paid in Full" value={money(started.paidInFull.totalRev)}
                sub={<>
                  {started.paidInFull.jobs} of {started.jobs} jobs started in range · Total Rev
                  {started.paidNotClosed.length > 0 && (
                    <span className="block mt-1 font-semibold text-amber-800" title={started.paidNotClosed.join(", ")}>
                      {started.paidNotClosed.length} paid but not closed out: {started.paidNotClosed.join(", ")}
                    </span>
                  )}
                  {started.paidStageOwed.jobs > 0 && (
                    <span className="block mt-1 font-semibold text-amber-800">{started.paidStageOwed.jobs} in a Paid stage with a balance still showing</span>
                  )}
                </>} />
            )}
            {started && (
              <Card tone="amber" label="Remaining Owed" value={money(started.remainingOwed.amount)}
                sub={`${started.remainingOwed.jobs} of ${started.jobs} jobs still owing · ${money(started.remainingOwed.totalRev)} Total Rev − ${money(started.remainingOwed.received)} received`} />
            )}
            {started && (
              <Card tone="blue" label={`Expected Collections · ${range}`} value={money(started.expected.amount)}
                sub={<>
                  {started.expected.jobs} job{started.expected.jobs === 1 ? "" : "s"} finishing in this period, not yet paid in full
                  {started.expected.jobs > 0 && (
                    <span className="block mt-1" title={started.expected.rows.map((r) => `${r.customer || r.label}: ${money(r.balance)} (${fmtDay(r.expectedDay)})`).join("\n")}>
                      {started.expected.rows.slice(0, 4).map((r) => `${r.customer || r.label} ${money(r.balance)}`).join(" · ")}{started.expected.jobs > 4 ? ` · +${started.expected.jobs - 4} more` : ""}
                    </span>
                  )}
                </>} />
            )}
            {started && (
              <Card tone="slate" label={`Invoiced AR · ${range}`} value={money(started.invoiced.amount)}
                sub={<>
                  <span title={started.invoiced.open.map((i) => `${i.customer} · ${i.number ?? "no number"} · ${fmtDay(i.date)}: ${money(i.open)}`).join("\n")}>
                    Unpaid on {started.invoiced.openInvoices} of {started.invoiced.invoices} invoice{started.invoiced.invoices === 1 ? "" : "s"} dated in this period ({money(started.invoiced.invoiced)} invoiced)
                  </span>
                  {started.invoiced.noInvoice.length > 0 && (
                    <span className="block mt-1 font-semibold text-red-700" title={started.invoiced.noInvoice.join(", ")}>
                      {started.invoiced.noInvoice.length} started with no invoice: {started.invoiced.noInvoice.slice(0, 4).join(", ")}{started.invoiced.noInvoice.length > 4 ? ` +${started.invoiced.noInvoice.length - 4} more` : ""}
                    </span>
                  )}
                </>} />
            )}
          </div>

          <GroupHeading>Owed today · not affected by the date filter</GroupHeading>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {started && data.ar && (() => {
              // Operational AR = what is owed on jobs still being built + Total AR (the
              // finished jobs, the card beside it), so the two cards always reconcile.
              const op = operationalAr(data.started.rows, data.today);
              const amount = Math.round((op.inProgress.amount + data.ar.totalAR) * 100) / 100;
              const jobs = op.inProgress.jobs + data.ar.totalARJobs;
              const building = op.rows.filter((r) => !r.finished);
              return (
                <Card tone="amber" label="Operational AR" value={money(amount)}
                  sub={<span title={building.map((r) => `${r.customer || r.label}: ${money(r.balance)}`).join("\n")}>
                    Everything still owed on {jobs} started job{jobs === 1 ? "" : "s"}:
                    <span className="block">{money(op.inProgress.amount)} on {op.inProgress.jobs} still being built + {money(data.ar.totalAR)} Total AR</span>
                  </span>} />
              );
            })()}
            {data.ar && (() => {
              const ar = data.ar;
              const names = (list) => list.map((r) => `${r.customer || r.label}: ${money(r.owed)} (${r.daysOutstanding ?? "?"} days)`).join("\n");
              return (<>
                <Card tone={ar.totalAR > 0 ? "amber" : "green"} label="Total AR · finished jobs" value={money(ar.totalAR)}
                  sub={<span title={names(ar.rows)}>{ar.totalARJobs} job{ar.totalARJobs === 1 ? "" : "s"} in Completed Need Final Payment or Collections, still owing · part of Operational AR</span>} />
                <Card tone={ar.overdueAR > 0 ? "red" : "green"} label={`Overdue AR · ${ar.overdueDays}+ days`} value={money(ar.overdueAR)}
                  sub={<span title={names(ar.rows.filter((r) => r.overdue))}>
                    {ar.overdueARJobs} finished job{ar.overdueARJobs === 1 ? "" : "s"} unpaid more than {ar.overdueDays} days after completion · 31–60: {money(ar.aging.d31_60)} · 61–90: {money(ar.aging.d61_90)} · 90+: {money(ar.aging.d90plus)}
                  </span>} />
              </>);
            })()}
            {started && (() => {
              const d = depositsMissing(data.started.rows, data.today);
              return (
                <Card tone={d.jobs > 0 ? "red" : "green"} label="Deposits Missing" value={`${d.jobs} job${d.jobs === 1 ? "" : "s"}`}
                  sub={<span title={d.rows.map((r) => `${r.customer}: started ${fmtDay(r.firstInstall)} · ${r.stage ?? ""} · ${money(r.totalRev)}`).join("\n")}>
                    {d.jobs === 0 ? "Every started job has a deposit recorded"
                      : <>Started with $0 deposit in JobProgress ({money(d.contract)} of contracts)
                          <span className="block mt-1 font-semibold">{d.rows.slice(0, 4).map((r) => r.customer).join(", ")}{d.jobs > 4 ? ` +${d.jobs - 4} more` : ""}</span></>}
                  </span>} />
              );
            })()}
          </div>

          {/* What the numbers cannot see. */}
          <div className="flex flex-wrap gap-2 text-xs">
            <FlagChip on={flag === "paidStageOwed"} onClick={() => setFlag(flag === "paidStageOwed" ? "" : "paidStageOwed")} tone={t.flags.paidStageOwed ? "amber" : "green"}>
              {t.flags.paidStageOwed} in a Paid stage but ledger shows {money(t.flags.paidStageOwedAmount)} owed
            </FlagChip>
            {t.flags.noContractValue > 0 && <FlagChip tone="red">{t.flags.noContractValue} started with no contract value</FlagChip>}
            {t.flags.noLedger > 0 && <FlagChip tone="amber">{t.flags.noLedger} with no ledger figures yet</FlagChip>}
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm">
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
              <div className="flex flex-wrap gap-1.5">
                <Chip on={status === "all" && !flag} onClick={() => { setStatus("all"); setFlag(""); }}>All started · {inRange.length}</Chip>
                {STATUSES.map((s) => (
                  <Chip key={s.key} on={status === s.key && !flag} onClick={() => { setStatus(s.key); setFlag(""); }}>{s.label} · {inRange.filter((r) => r.status === s.key).length}</Chip>
                ))}
              </div>
              <div className="relative ml-auto">
                <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, job #, town, stage, rep…"
                  className="pl-8 pr-3 py-2 text-sm border border-input rounded-lg w-72" />
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6 text-center">Nothing in this view.</p>
            ) : (
              <ScrollTable>
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-secondary">
                    <tr className="text-left text-muted-foreground border-b border-border text-xs uppercase tracking-wide whitespace-nowrap">
                      <th className="px-3 py-2 sticky left-0 z-20 bg-secondary">Customer</th>
                      <th className="px-3 py-2">Town / Address</th>
                      <th className="px-3 py-2">Sold By</th>
                      <th className="px-3 py-2">Job #</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Started</th>
                      <th className="px-3 py-2">Completed</th>
                      <th className="px-3 py-2 text-right">Contract $</th>
                      <th className="px-3 py-2 text-right">Deposit</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="px-3 py-2 text-right">Owed</th>
                      <th className="px-3 py-2">Last Payment</th>
                      <th className="px-3 py-2">Expected</th>
                      <th className="px-3 py-2 text-right">Days Out</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const st = STATUSES.find((s) => s.key === r.status);
                      const warn = r.noPayment && r.status !== "paid";
                      return (
                        <tr key={r.jobId} className={`border-b border-border/50 hover:bg-secondary ${r.overdue ? "bg-red-50" : warn ? "bg-amber-50" : "bg-white"}`}>
                          <td className="px-3 py-2 whitespace-nowrap sticky left-0 z-[1] bg-inherit shadow-[1px_0_0_0_hsl(var(--border))] font-semibold text-primary">{r.customer || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{[r.city, r.address].filter(Boolean).join(", ") || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.rep || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.jobNumber || "—"}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-block text-[11px] font-semibold px-1.5 py-0.5 rounded border mr-1.5 ${TONE[st?.tone ?? "slate"]}`}>{st?.label}</span>
                            <span className="text-xs text-muted-foreground">{r.stage}</span>
                            {r.paidStageOwed && <span className="ml-1.5 text-[11px] font-semibold text-amber-700">ledger still owed</span>}
                          </td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.startedDay)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.completedDay)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.noContractValue ? "text-red-700" : ""}`}>{r.noContractValue ? "none" : money(r.contract)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{r.deposit == null ? <span className={warn ? "text-red-700 font-semibold" : "text-muted-foreground"}>{warn ? "none" : "—"}</span> : money(r.deposit)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(r.received)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${r.owed > 0 ? "font-semibold" : "text-muted-foreground"}`}>{r.owed == null ? "—" : money(r.owed)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.lastPaymentDate)}</td>
                          <td className="px-3 py-2 whitespace-nowrap">{r.status === "paid" ? <span className="text-green-700 text-xs font-semibold">Paid</span> : fmtWeek(r.expectedWeek)}</td>
                          <td className={`px-3 py-2 text-right tabular-nums ${r.overdue ? "text-red-700 font-semibold" : ""}`}>{r.daysOutstanding == null ? "—" : r.daysOutstanding}</td>
                          <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Revenue Started for the range picked above: the Weekly Job Sheet's numbers.
 * Every job once, in the week its first install falls in (a multi-week job's
 * money is its first week's), weeks cut at the month end like the sheet, $0
 * jobs left out. Gross matches the sheet's Weekly Total and Cumulative rows.
 */
function StartedPanel({ s, range, today }) {
  const [open, setOpen] = useState(false);
  const plural = (n) => `${n} job${n === 1 ? "" : "s"}`;
  const byBlock = (w) => s.rows.filter((r) => r.firstInstall >= w.from && r.firstInstall <= w.to)
    .sort((a, b) => a.firstInstall.localeCompare(b.firstInstall) || String(a.customer ?? "").localeCompare(String(b.customer ?? "")));
  return (
    <section className="bg-white rounded-xl border border-border shadow-sm" aria-labelledby="started-h">
      <div className="p-4 flex flex-col lg:flex-row lg:items-start gap-4">
        <div className="lg:w-80 shrink-0 rounded-xl bg-primary text-primary-foreground p-4">
          <h2 id="started-h" className="text-[11px] uppercase tracking-wide font-semibold text-primary-foreground/80">Revenue Started · {range}</h2>
          {s.block && <div className="text-xs text-primary-foreground/80">{fmtDay(s.block.from)} – {fmtDay(s.block.to)}</div>}
          <div className="text-3xl font-heading font-bold tabular-nums mt-1">{money(s.gross)}</div>
          <div className="text-xs text-primary-foreground/80 mt-1">
            Gross, {plural(s.jobs)}
            {s.changeOrders ? <> · {money(s.totalRev)} with {money(s.changeOrders)} change orders</> : null}
          </div>
          {s.upcoming.jobs > 0 && (
            <div className="mt-3 pt-3 border-t border-primary-foreground/20 text-xs grid grid-cols-2 gap-2">
              <div><div className="text-primary-foreground/70">Already started</div><div className="font-semibold tabular-nums">{money(s.started.gross)} · {s.started.jobs}</div></div>
              <div><div className="text-primary-foreground/70">Still to start</div><div className="font-semibold tabular-nums">{money(s.upcoming.gross)} · {s.upcoming.jobs}</div></div>
            </div>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground mb-2">
            The Weekly Job Sheet&apos;s numbers: each job counted once, in the week its install starts, with weeks cut at the month end.
            Jobs with a $0 contract are left out.
          </p>
          {s.weeks.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">No installs start in this range.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-3 font-semibold">Sheet week</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Jobs</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Gross</th>
                    <th className="py-1.5 pr-3 font-semibold text-right">Change orders</th>
                    <th className="py-1.5 font-semibold text-right">Total Rev</th>
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {s.weeks.map((w) => (
                    <tr key={w.from} className="border-b border-border/50">
                      <td className="py-1.5 pr-3 whitespace-nowrap">{fmtDay(w.from)} – {fmtDay(w.to)}{w.from <= today && today <= w.to ? <span className="ml-1.5 text-[11px] font-semibold text-accent">this week</span> : null}</td>
                      <td className="py-1.5 pr-3 text-right">{w.jobs}</td>
                      <td className="py-1.5 pr-3 text-right font-semibold">{money(w.gross)}</td>
                      <td className="py-1.5 pr-3 text-right">{money(w.changeOrders)}</td>
                      <td className="py-1.5 text-right">{money(w.totalRev)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {s.jobs > 0 && (
            <button onClick={() => setOpen(!open)} aria-expanded={open} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent">
              {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}{open ? "Hide" : "Show"} the {plural(s.jobs)}
            </button>
          )}
        </div>
      </div>
      {open && (
        <div className="border-t border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-secondary">
              <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">
                <th className="px-3 py-2">Install starts</th><th className="px-3 py-2">Job</th><th className="px-3 py-2">Job #</th>
                <th className="px-3 py-2">Stage</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">C.O.</th>
                <th className="px-3 py-2 text-right">Total Rev</th><th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {s.weeks.flatMap((w) => byBlock(w).map((r) => (
                <tr key={r.jobId} className="border-b border-border/50">
                  <td className="px-3 py-1.5 whitespace-nowrap">{fmtDay(r.firstInstall)}{r.firstInstall > today ? <span className="ml-1.5 text-[11px] text-muted-foreground">upcoming</span> : null}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap font-semibold text-primary">{r.label || r.customer || "—"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{r.jobNumber || "—"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-xs text-muted-foreground">{r.stage || "—"}</td>
                  <td className="px-3 py-1.5 text-right">{r.gross == null ? <span className="text-red-700 font-semibold">not entered</span> : money(r.gross)}</td>
                  <td className="px-3 py-1.5 text-right">{money(r.changeOrders)}</td>
                  <td className="px-3 py-1.5 text-right">{money(r.totalRev)}</td>
                  <td className="px-3 py-1.5">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function GroupHeading({ children }) {
  return <h2 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground pt-1">{children}</h2>;
}

function Card({ tone, label, value, sub, onClick, active }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`text-left rounded-xl border p-3 shadow-sm ${TONE[tone]} ${onClick ? "hover:shadow-md" : ""} ${active ? "ring-2 ring-accent/50" : ""}`}>
      <div className={`text-[11px] uppercase tracking-wide font-semibold ${tone === "navy" ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{label}</div>
      <div className="text-2xl font-heading font-bold mt-0.5 tabular-nums">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${tone === "navy" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{sub}</div>}
    </Tag>
  );
}

function Chip({ on, onClick, children }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${on ? "bg-accent text-white" : "bg-secondary text-secondary-foreground hover:bg-secondary/70"}`}>
      {children}
    </button>
  );
}

function FlagChip({ on, onClick, tone, children }) {
  const Tag = onClick ? "button" : "span";
  return (
    <Tag onClick={onClick} className={`px-3 py-1.5 rounded-full font-semibold border ${TONE[tone]} ${on ? "ring-2 ring-accent/50" : ""}`}>{children}</Tag>
  );
}
