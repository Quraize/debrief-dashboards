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
import { revenueTotals, startedRevenue, STATUSES } from "@allied/shared/revenueAr";
import { QUEUE_DATE_FILTERS, ALL_TIME_FILTER, inDateRange } from "@allied/shared/constants";
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
    const list = range === ALL_TIME_FILTER ? all
      : block ? all.filter((r) => r.firstInstall >= block.from && r.firstInstall <= block.to)
      : all.filter((r) => inDateRange(r.firstInstall, range, cs, ce));
    return { rows: list, block, ...startedRevenue(list, data.today, splitFrom) };
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
          Of the work we <strong>started</strong> — first install visit done, job in a production or later stage — what it is worth, what
          has been paid in full, what is still owed, what is expected in this week and next, and what is overdue. Started figures follow the
          date range; expected cash and AR are always the whole book. <strong>Expected</strong> means the balance owed, in the week the
          job completes. <strong>Overdue</strong> is owed money more than {data?.totals.overdueDays ?? 30} days after completion.
        </p>
      </div>

      <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
        filters={QUEUE_DATE_FILTERS} />

      {isLoading || !t ? (
        error ? <p className="text-sm text-red-600">The summary could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {started && <StartedPanel s={started} range={range} today={data.today} />}

          {/* His numbers, his order. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Card tone="green" label="Paid in Full" value={money(t.paidInFull)} sub={`${t.paidInFullJobs} of ${t.jobs} started jobs in range`} onClick={() => { setStatus("paid"); setFlag(""); }} active={status === "paid" && !flag} />
            <Card tone="amber" label="Remaining Owed" value={money(t.remainingOwed)} sub={`${t.remainingOwedJobs} started jobs in range still owing`} onClick={() => { setStatus("all"); setFlag(""); }} active={status === "all" && !flag} />
            <Card tone="blue" label="Expected Collections This Week" value={money(t.expectedThisWeek)} sub={`${t.expectedThisWeekJobs} job${t.expectedThisWeekJobs === 1 ? "" : "s"} completing this week`} />
            <Card tone="blue" label="Expected Collections Next Week" value={money(t.expectedNextWeek)} sub={`${t.expectedNextWeekJobs} job${t.expectedNextWeekJobs === 1 ? "" : "s"} · ${fmtDay(t.nextWeek.from)} – ${fmtDay(t.nextWeek.to)}`} />
            <Card tone={t.totalAR > 0 ? "amber" : "green"} label="Total AR" value={money(t.totalAR)} sub={`${t.totalARJobs} completed, unpaid`} onClick={() => setFlag(flag === "ar" ? "" : "ar")} active={flag === "ar"} />
            <Card tone={t.overdueAR > 0 ? "red" : "green"} label={`Overdue AR (${t.overdueDays}+ days)`} value={money(t.overdueAR)}
              sub={`31–60: ${money(t.aging.d31_60)} · 61–90: ${money(t.aging.d61_90)} · 90+: ${money(t.aging.d90plus)}`} onClick={() => setFlag(flag === "overdue" ? "" : "overdue")} active={flag === "overdue"} />
          </div>

          {/* What the numbers cannot see. */}
          <div className="flex flex-wrap gap-2 text-xs">
            <FlagChip on={flag === "noPayment"} onClick={() => setFlag(flag === "noPayment" ? "" : "noPayment")} tone={t.flags.noPayment ? "red" : "green"}>
              {t.flags.noPayment} started job{t.flags.noPayment === 1 ? "" : "s"} with no payment recorded in JobProgress
            </FlagChip>
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
