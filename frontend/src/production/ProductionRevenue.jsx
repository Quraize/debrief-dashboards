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
import { revenueTotals, STATUSES } from "@allied/shared/revenueAr";
import { QUEUE_DATE_FILTERS, ALL_TIME_FILTER, inDateRange } from "@allied/shared/constants";
import DateRangeFilter from "@/components/DateRangeFilter";
import ScrollTable from "@/components/ScrollTable";
import { Loader2, ExternalLink, Search } from "lucide-react";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtWeek = (s) => (s ? "Wk of " + new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : "—");

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
  // The range applies to the START date by default (this is a started-revenue
  // view); switch it to the completion date to look at what finished.
  const [range, setRange] = useState("This Month");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [basis, setBasis] = useState("started");

  const book = data?.rows ?? [];
  const inRange = useMemo(() => {
    if (range === ALL_TIME_FILTER) return book;
    return book.filter((r) => inDateRange(basis === "started" ? r.startedDay : r.completedDay, range, cs, ce));
  }, [book, range, cs, ce, basis]);
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

      <div className="flex flex-col lg:flex-row lg:items-start gap-3">
        <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
          filters={QUEUE_DATE_FILTERS} className="flex-1" />
        <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Range applies to</div>
          <div className="flex rounded-lg border border-border overflow-hidden" role="group" aria-label="Which date the range filters">
            {[["started", "Start date"], ["completed", "Completion date"]].map(([k, label]) => (
              <button key={k} onClick={() => setBasis(k)} aria-pressed={basis === k}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${basis === k ? "bg-accent text-white" : "bg-white text-muted-foreground hover:bg-secondary"}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isLoading || !t ? (
        error ? <p className="text-sm text-red-600">The summary could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* His numbers, his order. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-8 gap-3">
            <Card tone="navy" label="Revenue Started This Week" value={money(t.startedThisWeek)} sub={`${t.startedThisWeekJobs} job${t.startedThisWeekJobs === 1 ? "" : "s"} · ${fmtDay(t.thisWeek.from)} – ${fmtDay(t.thisWeek.to)}`} />
            <Card tone="navy" label="Revenue Started Month to Date" value={money(t.startedMonthToDate)} sub={`${t.startedMonthToDateJobs} jobs started this month`} />
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
