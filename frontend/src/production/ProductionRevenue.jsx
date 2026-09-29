/**
 * Production Revenue & AR — management's cash view, on the Weekly Job Sheet's
 * jobs and rules (shared/src/revenueAr.js via GET /api/production/revenue).
 *
 * Three groups of cards: the selected period (Revenue Started, Paid in Full,
 * Remaining Owed, Invoiced AR), what customers owe today (Operational AR,
 * Total AR, Overdue AR, Progress Payments Due, Deposits Missing), and
 * Expected Collections from today (Today, Next 7 days, Next 14 days, Past
 * expected date). Clicking a card shows the jobs behind it in the one table
 * under the cards; the table's total is the card's number.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { PIPELINE_ROLES, REVENUE_DATE_FILTERS, ALL_TIME_FILTER, inDateRange } from "@allied/shared/constants";
import {
  startedRevenue, operationalAr, invoicedAr, depositsMissing, progressDue, expectedSchedule, sheetBalance, isCompletedStage, EXPECTED_DATE_RULE,
} from "@allied/shared/revenueAr";
import { PIF_STATUS } from "@allied/shared/weeklyJobSheet";
import { sheetWeekFrom } from "@allied/shared/production";
import DateRangeFilter from "@/components/DateRangeFilter";
import ScrollTable from "@/components/ScrollTable";
import { Loader2, ExternalLink, Search, Info } from "lucide-react";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : (Number(v) < 0 ? "−$" : "$") + Math.abs(Math.round(Number(v))).toLocaleString());
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? 0 : Number(v));
const plural = (n, w = "job") => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The week filters, as steps through the sheet's blocks from today's. */
const BLOCK_OFFSET = { "This Week": 0, "Last Week": -1, "Next Week": 1 };

const TONE = {
  red: "bg-red-50 text-red-900 border-red-200",
  green: "bg-green-50 text-green-900 border-green-200",
  blue: "bg-blue-50 text-blue-900 border-blue-200",
  amber: "bg-amber-50 text-amber-900 border-amber-200",
  slate: "bg-white text-primary border-border",
};

export default function ProductionRevenue() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && PIPELINE_ROLES.includes(me.role);
  const { data, isLoading, error } = useQuery({ queryKey: ["production-revenue"], queryFn: productionApi.revenue, enabled: allowed, staleTime: 60_000 });
  const [range, setRange] = useState("This Week");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [sel, setSel] = useState("started");
  const [q, setQ] = useState("");

  // Every card's figure, and the jobs behind it, from the sheet's jobs.
  const m = useMemo(() => {
    if (!data?.started || !data.ar) return null;
    const { rows: all, splitFrom } = data.started;
    const today = data.today;
    const block = BLOCK_OFFSET[range] === undefined ? null : sheetWeekFrom(today, BLOCK_OFFSET[range], splitFrom);
    // One test for "is this day in the period picked", used by every period card.
    const inPeriod = (day) => !!day && (range === ALL_TIME_FILTER ? true : block ? day >= block.from && day <= block.to : inDateRange(day, range, cs, ce));
    const list = all.filter((r) => inPeriod(r.firstInstall));
    const s = startedRevenue(list, today, splitFrom);
    const byId = new Map(all.map((r) => [r.jobId, r]));
    const received = (r) => num(r?.deposit) + num(r?.progressPayments);
    const totalRev = (r) => num(r?.gross) + num(r?.changeOrders);
    // A table row: the job's core columns, plus the card's own amount and note.
    const row = (jobId, amount, note = "", key = jobId) => {
      const j = byId.get(jobId) ?? {};
      return { key, jobId, customer: j.customer || j.label || jobId, jobNumber: j.jobNumber ?? null, stage: j.stage ?? null,
        firstInstall: j.firstInstall ?? null, totalRev: totalRev(j), received: received(j), amount, note, jpUrl: j.jpUrl ?? null };
    };

    const paid = list.filter((r) => r.pifStatus === PIF_STATUS.yes);
    // Expected Collections from today: owner is the Sold-Job Pipeline's Owner (each sheet job carries it).
    const ex = expectedSchedule(all, today, (id) => byId.get(id)?.owner ?? null);
    const exRows = (list2) => list2.map((r) => ({ ...row(r.jobId, r.amount), expectedDay: r.expectedDay, basis: r.basis, owner: r.owner, ownerSource: r.ownerSource }));
    const exCard = (key, title, when) => ({
      title, amountLabel: "Expected", total: ex[key].amount, value: money(ex[key].amount), tone: key === "pastDue" ? (ex[key].jobs ? "amber" : "green") : "blue",
      sub: <>{plural(ex[key].jobs)} · {when}</>, layout: "expected", rows: exRows(ex[key].rows),
    });
    const invoiced = invoicedAr(all, inPeriod, today);
    const invoiceRows = [];
    for (const r of all) for (const inv of r.invoices ?? []) {
      if (!inv.date || !inPeriod(inv.date)) continue;
      const open = /closed|void|cancel/i.test(String(inv.status ?? "")) ? 0 : Math.max(0, num(inv.open));
      if (open > 0) invoiceRows.push(row(r.jobId, open, `Invoice ${inv.number ?? "—"} · ${fmtDay(inv.date)}`, `${r.jobId}:${inv.number}`));
    }
    const noInvoiceIds = all.filter((r) => r.invoicesChecked !== false && r.firstInstall && r.firstInstall <= today && inPeriod(r.firstInstall) && !(r.invoices ?? []).length).map((r) => r.jobId);
    const op = operationalAr(all, today);
    const ar = data.ar;
    const prog = progressDue(all, today);
    const dep = depositsMissing(all, today);
    const building = op.rows.filter((r) => !r.finished);

    const cards = {
      started: {
        title: `Revenue Started · ${range}`, amountLabel: "Gross", total: s.gross,
        rows: [...list].sort((a, b) => String(a.firstInstall).localeCompare(String(b.firstInstall)))
          .map((r) => row(r.jobId, num(r.gross), r.firstInstall > today ? "Still to start" : "")),
      },
      paid: {
        title: `Paid in Full · ${range}`, amountLabel: "Total Rev", total: s.paidInFull.totalRev, value: money(s.paidInFull.totalRev), tone: "green",
        sub: <>
          {s.paidInFull.jobs} of {plural(s.jobs)} started in this period
          {s.paidNotClosed.length > 0 && <span className="block mt-1 font-semibold text-amber-800">{s.paidNotClosed.length} paid but not closed out</span>}
        </>,
        rows: paid.map((r) => row(r.jobId, num(r.totalRev), isCompletedStage(r.stage) ? "" : "Paid, not closed out")),
      },
      remaining: {
        title: `Remaining Owed · ${range}`, amountLabel: "Still owed", total: s.remainingOwed.amount, value: money(s.remainingOwed.amount), tone: "amber",
        sub: <>{s.remainingOwed.jobs} of {plural(s.jobs)} started in this period still owing</>,
        rows: list.map((r) => row(r.jobId, sheetBalance(r), sheetBalance(r) < 0 ? "Overpaid" : "")).filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount),
      },
      invoiced: {
        title: `Invoiced AR · ${range}`, amountLabel: "Open on invoice", total: invoiced.amount, value: money(invoiced.amount), tone: "slate",
        sub: <>
          Unpaid on {invoiced.openInvoices} of {plural(invoiced.invoices, "invoice")} dated in this period
          {invoiced.noInvoice.length > 0 && <span className="block mt-1 font-semibold text-red-700">{invoiced.noInvoice.length} started with no invoice</span>}
        </>,
        rows: [...invoiceRows.sort((a, b) => b.amount - a.amount), ...noInvoiceIds.map((id) => row(id, 0, "Started, no invoice in JobProgress"))],
      },
      operational: {
        title: "Operational AR · today", amountLabel: "Still owed", total: Math.round((op.inProgress.amount + ar.totalAR) * 100) / 100,
        value: money(op.inProgress.amount + ar.totalAR), tone: "amber",
        sub: <>{money(op.inProgress.amount)} on {op.inProgress.jobs} still being built + {money(ar.totalAR)} Total AR</>,
        rows: [...building.map((r) => row(r.jobId, r.balance, "Being built")), ...ar.rows.map((r) => row(r.jobId, r.owed, "Finished · Total AR"))]
          .sort((a, b) => b.amount - a.amount),
      },
      totalAr: {
        title: "Total AR · finished jobs", amountLabel: "Owed", total: ar.totalAR, value: money(ar.totalAR), tone: ar.totalAR > 0 ? "amber" : "green",
        sub: <>{plural(ar.totalARJobs)} in Completed Need Final Payment or Collections</>,
        rows: ar.rows.map((r) => row(r.jobId, r.owed, `${r.daysOutstanding ?? "?"} days since completion`)),
      },
      overdue: {
        title: `Overdue AR · ${ar.overdueDays}+ days`, amountLabel: "Owed", total: ar.overdueAR, value: money(ar.overdueAR), tone: ar.overdueAR > 0 ? "red" : "green",
        sub: <>31–60: {money(ar.aging.d31_60)} · 61–90: {money(ar.aging.d61_90)} · 90+: {money(ar.aging.d90plus)}</>,
        rows: ar.rows.filter((r) => r.overdue).map((r) => row(r.jobId, r.owed, `${r.daysOutstanding ?? "?"} days since completion`)),
      },
      progress: {
        title: "Progress Payments Due · today", amountLabel: "Still to collect", total: prog.amount, value: money(prog.amount), tone: prog.amount > 0 ? "amber" : "green",
        sub: <>
          After the deposit on {plural(prog.jobs)}
          {prog.noneYet.jobs > 0 && <span className="block mt-1 font-semibold text-red-700">{prog.noneYet.jobs} with no progress payment yet</span>}
        </>,
        rows: prog.rows.map((r) => row(r.jobId, r.due, r.progress <= 0 ? "No progress payment yet" : `${money(r.progress)} of ${money(r.afterDeposit)} collected`)),
      },
      exToday: exCard("today", "Expected today", fmtDay(today)),
      ex7: exCard("next7", "Expected in the next 7 days", `today through ${fmtDay(ex.next7.to)}`),
      ex14: exCard("next14", "Expected in the next 14 days", `today through ${fmtDay(ex.next14.to)}`),
      exPast: { ...exCard("pastDue", "Past expected date", "expected before today, not yet in"),
        sub: <>{plural(ex.pastDue.jobs)} expected before today and not yet in · also under Progress Payments Due and AR</> },
      deposits: {
        title: "Deposits Missing · today", amountLabel: "Contract", total: dep.contract, value: plural(dep.jobs), tone: dep.jobs > 0 ? "red" : "green",
        sub: <>Started with $0 deposit ({money(dep.contract)} of contracts)</>,
        rows: dep.rows.map((r) => row(r.jobId, r.totalRev, "No deposit recorded")),
      },
    };
    return { s, block, cards, today };
  }, [data, range, cs, ce]);

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Revenue &amp; AR is for managers: admin, sales manager or project manager.</div>;

  const current = m?.cards[sel];
  const shown = (current?.rows ?? []).filter((r) => {
    const t = q.trim().toLowerCase();
    return !t || [r.customer, r.jobNumber, r.stage, r.note].some((v) => String(v ?? "").toLowerCase().includes(t));
  });
  const pick = (key) => { setSel(key); setQ(""); };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Production Revenue &amp; AR</h1>
        <p className="text-sm text-muted-foreground max-w-4xl">
          The Weekly Job Sheet&apos;s jobs and numbers. The first group follows the date filter; the second is <strong>what customers owe today</strong>,
          whatever period is picked. Click any card to see the jobs behind it.
        </p>
      </div>

      <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
        filters={REVENUE_DATE_FILTERS} />

      {isLoading || !m ? (
        error ? <p className="text-sm text-red-600">The summary could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <StartedPanel s={m.s} block={m.block} range={range} today={m.today} active={sel === "started"} onSelect={() => pick("started")} />

          <GroupHeading>For the selected period · {range}{m.block ? ` (${fmtDay(m.block.from)} – ${fmtDay(m.block.to)})` : ""}</GroupHeading>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {["paid", "remaining", "invoiced"].map((k) => <CardFor key={k} k={k} c={m.cards[k]} sel={sel} pick={pick} />)}
          </div>

          <GroupHeading>Owed today · not affected by the date filter</GroupHeading>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            {["operational", "totalAr", "overdue", "progress", "deposits"].map((k) => <CardFor key={k} k={k} c={m.cards[k]} sel={sel} pick={pick} />)}
          </div>

          <GroupHeading>
            Expected Collections · from today, not affected by the date filter
            <span className="inline-flex align-middle ml-1.5 text-muted-foreground cursor-help normal-case" title={EXPECTED_DATE_RULE} aria-label={EXPECTED_DATE_RULE}>
              <Info className="w-3.5 h-3.5" /><span className="ml-1 text-[11px] font-normal">How is the date worked out?</span>
            </span>
          </GroupHeading>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {["exToday", "ex7", "ex14", "exPast"].map((k) => <CardFor key={k} k={k} c={m.cards[k]} sel={sel} pick={pick} hint={EXPECTED_DATE_RULE} />)}
          </div>

          <section className="bg-white rounded-xl border border-border shadow-sm" aria-labelledby="jobs-h">
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
              <h2 id="jobs-h" className="font-heading font-bold text-primary">
                {current.title} <span className="font-normal text-muted-foreground">· {plural(current.rows.length, current.rows.length && sel === "invoiced" ? "row" : "job")} · {money(current.total)}</span>
              </h2>
              <div className="relative ml-auto">
                <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, job #, stage…" aria-label="Search these jobs"
                  className="pl-8 pr-3 py-2 text-sm border border-input rounded-lg w-64" />
              </div>
            </div>
            {shown.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6 text-center">{current.rows.length ? "No job matches the search." : "No jobs behind this card."}</p>
            ) : (
              <ScrollTable>
                {current.layout === "expected" ? <ExpectedTable rows={shown} total={current.total} showTotal={!q} today={m.today} /> : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 z-10 bg-secondary">
                    <tr className="text-left text-muted-foreground border-b border-border text-xs uppercase tracking-wide whitespace-nowrap">
                      <th className="px-3 py-2 sticky left-0 z-20 bg-secondary">Customer</th>
                      <th className="px-3 py-2">Job #</th>
                      <th className="px-3 py-2">Stage</th>
                      <th className="px-3 py-2">Install started</th>
                      <th className="px-3 py-2 text-right">Total Rev</th>
                      <th className="px-3 py-2 text-right">Received</th>
                      <th className="px-3 py-2 text-right">{current.amountLabel}</th>
                      <th className="px-3 py-2">Note</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody className="tabular-nums">
                    {shown.map((r) => (
                      <tr key={r.key} className="border-b border-border/50 hover:bg-secondary bg-white">
                        <td className="px-3 py-2 whitespace-nowrap sticky left-0 z-[1] bg-inherit shadow-[1px_0_0_0_hsl(var(--border))] font-semibold text-primary">{r.customer}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{r.jobNumber || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{r.stage || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.firstInstall)}</td>
                        <td className="px-3 py-2 text-right">{money(r.totalRev)}</td>
                        <td className="px-3 py-2 text-right">{money(r.received)}</td>
                        <td className="px-3 py-2 text-right font-semibold">{money(r.amount)}</td>
                        <td className="px-3 py-2 whitespace-nowrap text-xs">{r.note || ""}</td>
                        <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
                      </tr>
                    ))}
                  </tbody>
                  {/* The total stays in view at the bottom while the rows scroll under it. */}
                  {!q && (
                    <tfoot className="sticky bottom-0 z-10">
                      <tr className="bg-secondary font-semibold shadow-[0_-1px_0_0_hsl(var(--border))]">
                        <td className="px-3 py-2 sticky left-0 z-20 bg-secondary" colSpan={6}>Total · the card&apos;s figure</td>
                        <td className="px-3 py-2 text-right tabular-nums bg-secondary">{money(current.total)}</td>
                        <td className="bg-secondary" colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>
                )}
              </ScrollTable>
            )}
          </section>
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
 * The navy card selects its jobs for the table below.
 */
function StartedPanel({ s, block, range, today, active, onSelect }) {
  return (
    <section className="bg-white rounded-xl border border-border shadow-sm" aria-label="Revenue Started">
      <div className="p-4 flex flex-col lg:flex-row lg:items-start gap-4">
        <button onClick={onSelect} aria-pressed={active}
          className={`lg:w-80 shrink-0 text-left rounded-xl bg-primary text-primary-foreground p-4 hover:shadow-md ${active ? "ring-4 ring-accent/60" : ""}`}>
          <span className="block text-[11px] uppercase tracking-wide font-semibold text-primary-foreground/80">Revenue Started · {range}</span>
          {block && <span className="block text-xs text-primary-foreground/80">{fmtDay(block.from)} – {fmtDay(block.to)}</span>}
          <span className="block text-3xl font-heading font-bold tabular-nums mt-1">{money(s.gross)}</span>
          <span className="block text-xs text-primary-foreground/80 mt-1">
            Gross, {plural(s.jobs)}
            {s.changeOrders ? <> · {money(s.totalRev)} with {money(s.changeOrders)} change orders</> : null}
          </span>
          {s.upcoming.jobs > 0 && (
            <span className="mt-3 pt-3 border-t border-primary-foreground/20 text-xs grid grid-cols-2 gap-2">
              <span><span className="block text-primary-foreground/70">Already started</span><span className="block font-semibold tabular-nums">{money(s.started.gross)} · {s.started.jobs}</span></span>
              <span><span className="block text-primary-foreground/70">Still to start</span><span className="block font-semibold tabular-nums">{money(s.upcoming.gross)} · {s.upcoming.jobs}</span></span>
            </span>
          )}
        </button>
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
        </div>
      </div>
    </section>
  );
}

function GroupHeading({ children }) {
  return <h2 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground pt-1">{children}</h2>;
}

/**
 * The Expected Collections jobs: expected date, customer, amount, owner,
 * stage, job #. The date and the owner say, on hover, where they come from;
 * an owner the team has not set on the Sold-Job Pipeline is marked as such.
 */
function ExpectedTable({ rows, total, showTotal, today }) {
  const basisText = { completion: "The job's completion date in JobProgress (the stage says it is finished).", lastInstall: "The job's last scheduled install day on the JobProgress calendar." };
  const ownerText = {
    rep: "The team has not set an Owner for this job on the Sold-Job Pipeline, so its sales rep is shown. Set the Owner there to change it.",
    none: "The team has not set an Owner for this job on the Sold-Job Pipeline, and the job has no sales rep in JobProgress.",
  };
  return (
    <table className="w-full text-sm">
      <thead className="sticky top-0 z-10 bg-secondary">
        <tr className="text-left text-muted-foreground border-b border-border text-xs uppercase tracking-wide whitespace-nowrap">
          <th className="px-3 py-2 cursor-help" title={EXPECTED_DATE_RULE}>Expected date <Info className="inline w-3 h-3 align-[-1px]" /></th>
          <th className="px-3 py-2 sticky left-0 z-20 bg-secondary">Customer</th>
          <th className="px-3 py-2 text-right">Amount</th>
          <th className="px-3 py-2 cursor-help" title="The Owner set on the Sold-Job Pipeline. Where the team has not set one, the sales rep is shown and marked.">Owner <Info className="inline w-3 h-3 align-[-1px]" /></th>
          <th className="px-3 py-2">Stage</th>
          <th className="px-3 py-2">Job #</th>
          <th className="px-3 py-2" />
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {rows.map((r) => (
          <tr key={r.key} className="border-b border-border/50 hover:bg-secondary bg-white">
            <td className="px-3 py-2 whitespace-nowrap cursor-help" title={basisText[r.basis]}>
              {fmtDay(r.expectedDay)}{r.expectedDay === today ? <span className="ml-1.5 text-[11px] font-semibold text-accent">today</span> : null}
              <span className="block text-[11px] text-muted-foreground">{r.basis === "completion" ? "completion date" : "last install day"}</span>
            </td>
            <td className="px-3 py-2 whitespace-nowrap sticky left-0 z-[1] bg-inherit shadow-[1px_0_0_0_hsl(var(--border))] font-semibold text-primary">{r.customer}</td>
            <td className="px-3 py-2 text-right font-semibold">{money(r.amount)}</td>
            <td className="px-3 py-2 whitespace-nowrap">
              {r.ownerSource === "pipeline" ? r.owner
                : r.ownerSource === "rep" ? <span className="cursor-help" title={ownerText.rep}>{r.owner} <span className="text-[11px] text-amber-800 font-semibold">(rep · no owner set by team)</span></span>
                : <span className="cursor-help text-red-700 font-semibold" title={ownerText.none}>Not set by team</span>}
            </td>
            <td className="px-3 py-2 whitespace-nowrap text-xs text-muted-foreground">{r.stage || "—"}</td>
            <td className="px-3 py-2 whitespace-nowrap">{r.jobNumber || "—"}</td>
            <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
          </tr>
        ))}
      </tbody>
      {showTotal && (
        <tfoot className="sticky bottom-0 z-10">
          <tr className="bg-secondary font-semibold shadow-[0_-1px_0_0_hsl(var(--border))]">
            <td className="px-3 py-2 bg-secondary" />
            <td className="px-3 py-2 sticky left-0 z-20 bg-secondary">Total · the card&apos;s figure</td>
            <td className="px-3 py-2 text-right tabular-nums bg-secondary">{money(total)}</td>
            <td className="bg-secondary" colSpan={4} />
          </tr>
        </tfoot>
      )}
    </table>
  );
}

/** A card that selects its jobs for the table below. `hint` is its hover explanation. */
function CardFor({ k, c, sel, pick, hint }) {
  const active = sel === k;
  return (
    <button onClick={() => pick(k)} aria-pressed={active} title={hint}
      className={`text-left rounded-xl border p-3 shadow-sm hover:shadow-md ${TONE[c.tone ?? "slate"]} ${active ? "ring-2 ring-accent ring-offset-1" : ""}`}>
      <span className="block text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">{c.title}</span>
      <span className="block text-2xl font-heading font-bold mt-0.5 tabular-nums">{c.value}</span>
      <span className="block text-[11px] mt-0.5 text-muted-foreground">{c.sub}</span>
      <span className="block text-[11px] mt-1.5 font-semibold text-accent">{active ? "Showing its jobs below" : "Show the jobs"}</span>
    </button>
  );
}
