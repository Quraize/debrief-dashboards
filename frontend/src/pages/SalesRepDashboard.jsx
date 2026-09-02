import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import DashboardSwitcher from "@/components/DashboardSwitcher";
import KpiCard from "@/components/KpiCard";
import {
  repStatsFromDebriefs, filterByDate, filterByEffectiveSaleDate,
  appointmentQualityStats, twoLegStats, isSale, isAppointmentOpportunity,
  APPOINTMENT_OPPORTUNITIES_DEFINITION,
  DEMO_RATE_DEFINITION, NO_DEMO_RATE_DEFINITION, NO_SEE_RATE_DEFINITION, TWO_LEG_DEFINITION
} from "@allied/shared/kpi";
import { DEMO_OUTCOMES } from "@allied/shared/constants";
import { nonInsuranceDebriefs, insuranceDebriefs } from "@allied/shared/insurance";
import { classifyAppointment, classificationCounts, enrichDebriefsWithTitles } from "@allied/shared/appointmentClassification";
import ClassificationCounts from "@/components/ClassificationCounts";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, LabelList } from "recharts";
import { Loader2 } from "lucide-react";
import { JpRepSection, DebriefSectionHeader } from "@/components/JpCrmSection";

const NAVY = "#1e293b";
const GOLD = "#b45309";
const COLS = ["Appointments", "Two-Leg", "Two-Leg %", "Demos", "Demo %", "No Demo", "No See", "Jobs In", "Cred. Sales", "Sales %", "Cred. Revenue", "Avg Job Size"];

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

export default function SalesRepDashboard() {
  const [filter, setFilter] = useState("This Month");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [reportingGroup, setReportingGroup] = useState("all");

  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });
  const enrichedDb = useMemo(() => enrichDebriefsWithTitles(debriefs, appointments), [debriefs, appointments]);

  const GROUP_MAP = { roofing: "Roofing", siding: "Siding", roofing_siding: "Roofing + Siding", commercial: "Commercial", repairs: "Repairs", misc: "Misc" };
  const groupFiltered = useMemo(() => {
    if (reportingGroup === "all") return nonInsuranceDebriefs(enrichedDb);
    if (reportingGroup === "insurance") return insuranceDebriefs(enrichedDb);
    const target = GROUP_MAP[reportingGroup];
    return enrichedDb.filter((d) => classifyAppointment(d).reporting_division === target);
  }, [enrichedDb, reportingGroup]);

  // All debriefs in period (for classification counts — not group-filtered)
  const allPeriodDb = useMemo(() => filterByDate(enrichedDb, "appointment_date", filter, cs, ce), [enrichedDb, filter, cs, ce]);
  const classCounts = useMemo(() => classificationCounts(allPeriodDb), [allPeriodDb]);

  // Group-filtered KPIs
  const apptDb = useMemo(() => filterByDate(groupFiltered, "appointment_date", filter, cs, ce), [groupFiltered, filter, cs, ce]);
  // Two-Leg scoped to the selected group (Residential Install eligible only — 0 denominator for Other/MISC and Insurance)
  const tl = useMemo(() => twoLegStats(apptDb), [apptDb]);
  const saleDb = useMemo(() => filterByEffectiveSaleDate(groupFiltered, filter, cs, ce).filter(isSale), [groupFiltered, filter, cs, ce]);
  const periodStats = useMemo(() => repStatsFromDebriefs(groupFiltered, filter, cs, ce), [groupFiltered, filter, cs, ce]);
  const ytdStats = useMemo(() => repStatsFromDebriefs(groupFiltered, "Year to Date", "", ""), [groupFiltered]);

  // Team totals (selected period)
  const aq = useMemo(() => appointmentQualityStats(apptDb), [apptDb]);
  const teamAppts = apptDb.filter(isAppointmentOpportunity).length;
  const teamDemos = apptDb.filter((d) => DEMO_OUTCOMES.includes(d.appointment_outcome)).length;
  const teamSales = saleDb.length;
  const teamRevenue = saleDb.reduce((s, d) => s + num(d.sale_amount), 0);
  const teamDemoPct = aq.demoRate;
  const teamTwoLegPct = tl.rate;
  const teamSalesPct = teamDemos > 0 ? Math.round((teamSales / teamDemos) * 100) : 0;
  const teamAvgJob = teamSales > 0 ? Math.round(teamRevenue / teamSales) : 0;

  const isMonth = filter === "This Month";

  // Chart data (descending)
  const revenueData = [...periodStats].sort((a, b) => b.revenue - a.revenue).map((s) => ({ name: s.name, value: s.revenue }));
  const salesPctData = [...periodStats].sort((a, b) => b.salesPctNum - a.salesPctNum).map((s) => ({ name: s.name, value: s.salesPctNum }));
  const demoPctData = [...periodStats].sort((a, b) => b.demoRateNum - a.demoRateNum).map((s) => ({ name: s.name, value: s.demoRateNum }));
  const avgJobData = [...periodStats].sort((a, b) => b.avgJobNum - a.avgJobNum).map((s) => ({ name: s.name, value: s.avgJobNum }));

  // Combined rep comparison (period + YTD)
  const comparisonRows = useMemo(() => {
    const map = {};
    periodStats.forEach((s) => { map[s.name] = { period: s }; });
    ytdStats.forEach((s) => { if (!map[s.name]) map[s.name] = {}; map[s.name].ytd = s; });
    return Object.keys(map).sort((a, b) => (map[b].period?.appointments || 0) - (map[a].period?.appointments || 0)).map((name) => ({ name, period: map[name].period, ytd: map[name].ytd }));
  }, [periodStats, ytdStats]);

  return (
    <div className="space-y-4">
      <DashboardSwitcher />
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Sales Rep Performance Dashboard</h1>
        <p className="text-sm text-muted-foreground">Per-rep performance. Appointment metrics by appointment date; sales, revenue, and average job size by signed month.</p>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      {/* Reporting Group filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Reporting Group:</span>
        {[
          { key: "all", label: "All Sales Appts" },
          { key: "roofing", label: "Roofing" },
          { key: "siding", label: "Siding" },
          { key: "roofing_siding", label: "Roofing + Siding" },
          { key: "commercial", label: "Commercial" },
          { key: "repairs", label: "Repairs" },
          { key: "misc", label: "Misc" },
          { key: "insurance", label: "Insurance" },
        ].map((g) => (
          <button key={g.key} onClick={() => setReportingGroup(g.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              reportingGroup === g.key ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {g.label}
          </button>
        ))}
      </div>

      <ClassificationCounts counts={classCounts} />

      <DebriefSectionHeader />

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : periodStats.length === 0 && teamSales === 0 ? (
        <div className="text-center text-muted-foreground py-8 text-sm">No debriefs or sales in this period.</div>
      ) : (
        <>
          {/* Primary KPI strip — exact order */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard label="Appointments" value={teamAppts} title={APPOINTMENT_OPPORTUNITIES_DEFINITION} />
            <KpiCard label="Two-Leg" value={tl.twoLeg} title="Two-Leg count among eligible attended Appointment Opportunities (Roofing, Siding, Roofing + Siding only). Uses the record's actual Decision Maker Status." />
            <KpiCard label="Two-Leg %" value={tl.denominator > 0 ? teamTwoLegPct + "%" : "—"} title="Two-Leg count ÷ eligible attended Appointment Opportunities (Roofing, Siding, Roofing + Siding only)." />
            <KpiCard label="Demos" value={teamDemos} />
            <KpiCard label="Demo %" value={aq.aqOpportunities > 0 ? teamDemoPct + "%" : "—"} />
            <CountWithChip label="No Demo" value={aq.aqNoDemo} chip={aq.aqAttended > 0 ? aq.noDemoRate + "%" : ""} />
            <CountWithChip label="No See" value={aq.aqNoSee} chip={aq.aqNoSeeDenom > 0 ? aq.noSeeRate + "%" : ""} />
            <KpiCard label="Sales" value={teamSales} accent />
            <KpiCard label="Sales %" value={teamDemos > 0 ? teamSalesPct + "%" : "0%"} />
            <KpiCard label="Revenue" value={"$" + teamRevenue.toLocaleString()} />
            <KpiCard label="Average Job Size" value={teamSales > 0 ? "$" + teamAvgJob.toLocaleString() : "$0"} />
          </div>

          {/* Two-Leg context — Residential Install only, prevents 1/1 without context */}
          <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">Two-Leg Breakdown (Roofing, Siding, Roofing + Siding eligible only)</div>
            <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2">
              <MiniStat label="Two-Leg" value={tl.twoLeg} />
              <MiniStat label="Denominator" value={tl.denominator} />
              <MiniStat label="Two-Leg %" value={tl.denominator > 0 ? tl.rate + "%" : "—"} />
              <MiniStat label="One-Leg" value={tl.oneLeg} />
              <MiniStat label="Missing Answer" value={tl.missingAnswer} />
              <MiniStat label="Excluded No C/No Show" value={tl.excludedNoCNoShow} />
              <MiniStat label="N/A / Needs Review" value={tl.naNeedsReview} />
            </div>
          </div>

          {/* Secondary diagnostics — below the primary strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Reset Needed" value={aq.aqResetNeeded} />
            <KpiCard label="Reset Rate" value={aq.aqOpportunities > 0 ? aq.resetRate + "%" : "—"} />
            <KpiCard label="Completed Reset Demos" value={aq.aqCompletedResetDemo} />
            <KpiCard label="Reset Recovery Rate" value={aq.aqResetNeeded > 0 ? aq.resetRecoveryRate + "%" : "—"} />
          </div>

          <div className="bg-secondary/40 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
            <p><strong className="text-foreground">Date attribution:</strong> Appointments, Two-Leg, Demos, Demo %, No Demo, and No See use the <em>appointment date</em>. Sales, Revenue, and Average Job Size use the <em>signed month</em> (Sale Signed Date, falling back to appointment date for legacy sales).</p>
            <p><strong className="text-foreground">Split-Sale Credits:</strong> <em>Jobs In</em> = sales the rep participated in (primary or secondary). <em>Cred. Sales</em> = fractional sale count (split %). <em>Cred. Revenue</em> = sale amount × split %. Team Sales and Revenue remain unduplicated (each sale counted once). Secondary reps appear even with no primary-owned debriefs.</p>
            <p><strong className="text-foreground">Sales %</strong> = sales whose signed month is in the selected period ÷ demos whose appointment date is in the selected period (0% when no demos).</p>
            <p><strong className="text-foreground">Demo %</strong> {DEMO_RATE_DEFINITION}</p>
            <p><strong className="text-foreground">No Demo %</strong> {NO_DEMO_RATE_DEFINITION}</p>
            <p><strong className="text-foreground">No See %</strong> {NO_SEE_RATE_DEFINITION}</p>
            <p><strong className="text-foreground">Two-Leg %</strong> {TWO_LEG_DEFINITION}</p>
          </div>

          {/* 2x2 chart grid */}
          <div className="grid md:grid-cols-2 gap-4">
            <HBarChart title="Revenue by Rep" data={revenueData} color={NAVY} money />
            <HBarChart title="Sales Ratio by Rep" data={salesPctData} color={GOLD} pct />
            <HBarChart title="Demo Ratio by Rep" data={demoPctData} color={NAVY} pct />
            <HBarChart title="Average Job Size by Rep" data={avgJobData} color={GOLD} money />
          </div>

          {/* Rep comparison — Selected Period vs YTD */}
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="p-3 border-b border-border/60">
              <h2 className="font-heading font-bold text-sm text-primary">Rep Performance — Selected Period vs Year to Date</h2>
              <p className="text-xs text-muted-foreground">
                {isMonth ? "Comparing This Month (currently August) with Year to Date." : `Comparing ${filter} with Year to Date.`}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-max">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-left text-muted-foreground">
                    <th className="px-2.5 py-2 font-semibold whitespace-nowrap">Rep</th>
                    <th className="px-2.5 py-2 font-semibold whitespace-nowrap">View</th>
                    {COLS.map((h) => <th key={h} className="px-2.5 py-2 font-semibold whitespace-nowrap uppercase tracking-wide text-center">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {comparisonRows.map((r) => (
                    <RepComparisonRow key={r.name} name={r.name} period={r.period} ytd={r.ytd} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </>
      )}

      {/* Independent of the debrief section by design — never gated on it. */}
      <JpRepSection filter={filter} cs={cs} ce={ce} debriefs={debriefs} />
    </div>
  );
}

function RepComparisonRow({ name, period, ytd }) {
  const rows = [
    { view: "Selected Period", s: period },
    { view: "Year to Date", s: ytd },
  ];
  return rows.map((r, i) => (
    <tr key={r.view} className="border-b border-border/50 hover:bg-secondary/30">
      {i === 0 ? <td rowSpan={2} className="px-2.5 py-2 font-bold text-primary whitespace-nowrap align-top">{name}</td> : null}
      <td className="px-2.5 py-2 text-muted-foreground whitespace-nowrap">{r.view}</td>
      <CompareCells s={r.s} />
    </tr>
  ));
}

function CompareCells({ s }) {
  if (!s) return <td colSpan={COLS.length} className="px-2.5 py-2 text-muted-foreground italic">No data</td>;
  const cells = [
    s.appointments,
    `${s.twoLeg}/${s.twoLegDenom}`,
    s.twoLegPct,
    s.demos,
    s.demoRatePct,
    s.noDemo,
    s.noSee,
    s.jobsParticipated,
    Number.isFinite(s.creditedSales) ? (Number.isInteger(s.creditedSales) ? s.creditedSales : s.creditedSales.toFixed(1)) : 0,
    s.salesPct,
    "$" + num(s.creditedRevenue).toLocaleString(),
    s.avgJob,
  ];
  return cells.map((c, i) => (
    <td key={i} className="px-2.5 py-2 text-center whitespace-nowrap font-medium text-primary">{c}</td>
  ));
}

function MiniStat({ label, value }) {
  return (
    <div className="text-center">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className="text-lg font-heading font-bold text-primary">{value}</div>
    </div>
  );
}

function CountWithChip({ label, value, chip }) {
  return (
    <div className="rounded-xl border border-border bg-white p-4 shadow-sm">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold leading-tight">{label}</div>
      <div className="text-2xl font-heading font-bold text-primary mt-1">{value}</div>
      {chip && <span className="inline-block mt-1 text-[10px] font-bold bg-secondary text-secondary-foreground px-1.5 py-0.5 rounded-full">{chip}</span>}
    </div>
  );
}

function HBarChart({ title, data, color, money, pct }) {
  const allZero = data.every((d) => !d.value);
  const height = Math.max(180, data.length * 38);
  const fmt = (v) => money ? "$" + Number(v).toLocaleString() : (pct ? v + "%" : v);
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <h2 className="font-heading font-bold text-sm text-primary mb-3">{title}</h2>
      {allZero ? (
        <div className="h-32 flex items-center justify-center text-xs text-muted-foreground">No data for this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height={height}>
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 48 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
            <XAxis type="number" tick={{ fontSize: 11 }} hide={false} />
            <YAxis dataKey="name" type="category" width={92} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(v) => fmt(v)} />
            <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]}>
              <LabelList dataKey="value" position="right" formatter={(v) => fmt(v)} style={{ fontSize: 10, fill: "#475569" }} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}