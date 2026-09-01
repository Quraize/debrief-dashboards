import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import DashboardSwitcher from "@/components/DashboardSwitcher";
import KpiCard from "@/components/KpiCard";
import FilterSelect from "@/components/FilterSelect";
import {
  marketingSourceStats, marketingCategoryStats, normalizeSource, uniqueLeadCount, filterByDate,
  appointmentQualityStats, twoLegStats, isSale,
  DEMO_RATE_DEFINITION, NO_DEMO_RATE_DEFINITION, NO_SEE_RATE_DEFINITION, TWO_LEG_DEFINITION
} from "@allied/shared/kpi";
import { FIRST_CALL_CLOSE, DEMO_OUTCOMES } from "@allied/shared/constants";
import { nonInsuranceDebriefs } from "@allied/shared/insurance";
import { getMarketingCategory, isUnmappedSource, isSelfGenNeedsDetail, MARKETING_CATEGORIES, ALL_MARKETING_SOURCES } from "@allied/shared/marketingSources";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ComposedChart, Line } from "recharts";
import { Loader2, ChevronDown, ChevronRight, Info, AlertTriangle } from "lucide-react";

function num(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function pct(a, b) { return b > 0 ? Math.round((a / b) * 100) : 0; }
function money(v) { return "$" + num(v).toLocaleString(); }
function compactMoney(v) {
  const n = num(v);
  if (Math.abs(n) >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M";
  if (Math.abs(n) >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + n.toLocaleString();
}
function monthKey(s) { return s ? s.slice(0, 7) : ""; }

export default function MarketingDashboard() {
  const [filter, setFilter] = useState("This Quarter");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [source, setSource] = useState("");
  const [mktCategory, setMktCategory] = useState("");
  const [subsource, setSubsource] = useState("");
  const [div, setDiv] = useState("");
  const [rep, setRep] = useState("");
  const [setter, setSetter] = useState("");
  const [expandedSrc, setExpandedSrc] = useState(null);
  const [defsOpen, setDefsOpen] = useState(false);

  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });

  const retailDebriefs = useMemo(() => nonInsuranceDebriefs(debriefs), [debriefs]);
  const sourceOptions = useMemo(() => {
    const set = new Set();
    ALL_MARKETING_SOURCES.forEach((s) => set.add(s));
    retailDebriefs.forEach((d) => set.add(normalizeSource(d.marketing_source)));
    return [...set].sort((a, b) => (a === "Unassigned" ? 1 : 0) - (b === "Unassigned" ? 1 : 0) || a.localeCompare(b));
  }, [retailDebriefs]);

  const filtered = useMemo(() => {
    let r = filterByDate(retailDebriefs, "appointment_date", filter, cs, ce);
    if (mktCategory) r = r.filter((d) => getMarketingCategory(d.marketing_source) === mktCategory);
    if (source) r = r.filter((d) => normalizeSource(d.marketing_source) === source);
    if (subsource) r = r.filter((d) => d.self_gen_source === subsource);
    if (div) r = r.filter((d) => d.product === div);
    if (rep) r = r.filter((d) => d.sales_rep === rep);
    if (setter) r = r.filter((d) => d.appointment_setter === setter);
    return r;
  }, [retailDebriefs, filter, cs, ce, mktCategory, source, subsource, div, rep, setter]);

  const aq = useMemo(() => appointmentQualityStats(filtered), [filtered]);
  const tl = useMemo(() => twoLegStats(filtered), [filtered]);
  const salesRecs = useMemo(() => filtered.filter(isSale), [filtered]);
  const revenue = salesRecs.reduce((s, d) => s + num(d.sale_amount), 0);
  const firstCallCloses = filtered.filter((d) => d.sale_close_type === FIRST_CALL_CLOSE).length;
  const leads = uniqueLeadCount(filtered);
  const eligible = aq.aqOpportunities + aq.aqNoSee;
  const missingLeadIds = filtered.filter((d) => !d.crm_lead_id).length;
  const unassignedCount = filtered.filter((d) => normalizeSource(d.marketing_source) === "Unassigned").length;
  const unmappedCount = filtered.filter((d) => isUnmappedSource(d.marketing_source)).length;
  const selfGenNeedsDetailCount = filtered.filter((d) => isSelfGenNeedsDetail(d.marketing_source)).length;
  const lastUpdated = useMemo(() => {
    const ts = debriefs.map((d) => d.updated_date).filter(Boolean).sort().pop();
    return ts ? new Date(ts).toLocaleString() : "—";
  }, [debriefs]);

  const srcStats = useMemo(() => marketingSourceStats(filtered), [filtered]);
  const catStats = useMemo(() => marketingCategoryStats(filtered), [filtered]);
  const catTotals = useMemo(() => {
    const t = { count: 0, eligibleAppts: 0, demos: 0, sales: 0, revenue: 0 };
    catStats.forEach((r) => { t.count += r.count; t.eligibleAppts += r.eligibleAppts; t.demos += r.demos; t.sales += r.sales; t.revenue += r.revenue; });
    return t;
  }, [catStats]);

  const totals = useMemo(() => {
    const t = { uniqueLeads: 0, eligibleAppts: 0, demos: 0, noDemo: 0, noSee: 0, twoLeg: 0, twoLegDenom: 0, sales: 0, revenue: 0, firstCallClose: 0 };
    srcStats.forEach((r) => {
      t.uniqueLeads += r.uniqueLeads; t.eligibleAppts += r.eligibleAppts; t.demos += r.demos;
      t.noDemo += r.noDemo; t.noSee += r.noSee; t.twoLeg += r.twoLeg; t.twoLegDenom += r.twoLegDenom;
      t.sales += r.sales; t.revenue += r.revenue; t.firstCallClose += r.firstCallClose;
    });
    return t;
  }, [srcStats]);

  const topSources = (key, n = 10) => {
    const sorted = [...srcStats].sort((a, b) => num(b[key]) - num(a[key]));
    const top = sorted.slice(0, n);
    const rest = sorted.slice(n);
    if (rest.length) {
      const other = { source: "Other", demos: 0, revenue: 0, eligibleAppts: 0, sales: 0, demoRate: 0, salesRate: 0 };
      rest.forEach((r) => { other.demos += r.demos; other.revenue += r.revenue; other.eligibleAppts += r.eligibleAppts; other.sales += r.sales; });
      other.demoRate = pct(other.demos, other.eligibleAppts);
      other.salesRate = pct(other.sales, other.demos);
      top.push(other);
    }
    return top;
  };
  const volumeData = topSources("eligibleAppts");
  const revenueData = topSources("revenue");
  const rateData = topSources("demos").map((s) => ({ source: s.source, demoRate: s.demoRate, salesRate: s.salesRate }));

  const trendData = useMemo(() => {
    const map = {};
    filtered.forEach((d) => {
      if (!d.appointment_date) return;
      const k = monthKey(d.appointment_date);
      if (!map[k]) map[k] = { month: k, appts: 0, demos: 0, sales: 0, revenue: 0 };
      const g = map[k];
      g.appts++;
      if (DEMO_OUTCOMES.includes(d.appointment_outcome)) g.demos++;
      if (isSale(d)) { g.sales++; g.revenue += num(d.sale_amount); }
    });
    return Object.values(map).sort((a, b) => a.month.localeCompare(b.month));
  }, [filtered]);

  const divisionData = useMemo(() => {
    const map = {};
    filtered.forEach((d) => {
      const k = d.product || "Unassigned";
      if (!map[k]) map[k] = { division: k, count: 0, revenue: 0 };
      map[k].count++;
      if (isSale(d)) map[k].revenue += num(d.sale_amount);
    });
    return Object.values(map).sort((a, b) => b.count - a.count);
  }, [filtered]);

  function clearAll() { setMktCategory(""); setSource(""); setSubsource(""); setDiv(""); setRep(""); setSetter(""); }

  return (
    <div className="space-y-4">
      <DashboardSwitcher />
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Marketing Dashboard</h1>
        <p className="text-sm text-muted-foreground">Lead source performance — attribution by marketing/referral source. Last updated {lastUpdated}.</p>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <FilterField label="Marketing Category">
            <select value={mktCategory} onChange={(e) => setMktCategory(e.target.value)} className="w-full border border-input rounded-lg px-2 py-2 text-sm font-medium bg-white">
              <option value="">All Categories</option>
              {MARKETING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </FilterField>
          <FilterField label="Primary Source">
            <select value={source} onChange={(e) => setSource(e.target.value)} className="w-full border border-input rounded-lg px-2 py-2 text-sm font-medium bg-white">
              <option value="">All Sources</option>
              {sourceOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </FilterField>
          <FilterField label="Self-Gen Subsource">
            <FilterSelect debriefs={debriefs} field="self_gen_source" value={subsource} onChange={setSubsource} placeholder="All Subsources" />
          </FilterField>
          <FilterField label="Division">
            <FilterSelect debriefs={debriefs} field="product" value={div} onChange={setDiv} placeholder="All Divisions" />
          </FilterField>
          <FilterField label="Sales Rep">
            <FilterSelect debriefs={debriefs} field="sales_rep" value={rep} onChange={setRep} placeholder="All Reps" />
          </FilterField>
          <FilterField label="Appointment Setter">
            <FilterSelect debriefs={debriefs} field="appointment_setter" value={setter} onChange={setSetter} placeholder="All Setters" />
          </FilterField>
        </div>
        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
          <span>{filtered.length} debriefs in range</span>
          {(source || subsource || div || rep || setter) && (
            <button onClick={clearAll} className="font-semibold text-accent underline">Clear filters</button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-xs">
        <span className="bg-amber-50 text-amber-700 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Unassigned source: {unassignedCount}</span>
        {selfGenNeedsDetailCount > 0 && <span className="bg-amber-50 text-amber-700 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Self-Gen Needs Subtype: {selfGenNeedsDetailCount}</span>}
        {unmappedCount > 0 && <span className="bg-red-50 text-red-700 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Unmapped / Needs Cleanup: {unmappedCount}</span>}
        <span className="bg-amber-50 text-amber-700 font-semibold px-2.5 py-1 rounded-full flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Missing Lead ID: {missingLeadIds}</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            <KpiCard label="Unique Leads" value={leads} accent />
            <KpiCard label="Eligible Appointments" value={eligible} />
            <KpiCard label="Demos" value={aq.aqDemos} />
            <KpiCard label="Demo Rate" value={aq.demoRate + "%"} />
            <KpiCard label="No Demo" value={aq.aqNoDemo} />
            <KpiCard label="No Demo Rate" value={aq.noDemoRate + "%"} />
            <KpiCard label="No See" value={aq.aqNoSee} />
            <KpiCard label="No See Rate" value={aq.noSeeRate + "%"} />
            <KpiCard label="Sales" value={salesRecs.length} />
            <KpiCard label="Sales / Close Rate" value={pct(salesRecs.length, aq.aqDemos) + "%"} />
            <KpiCard label="Revenue" value={money(revenue)} />
            <KpiCard label="Average Sale" value={salesRecs.length ? money(Math.round(revenue / salesRecs.length)) : "$0"} />
            <KpiCard label="Two-Leg" value={tl.twoLeg} />
            <KpiCard label="Two-Leg Rate" value={tl.denominator > 0 ? tl.rate + "%" : "—"} />
            <KpiCard label="First Call Close" value={firstCallCloses} />
            <KpiCard label="First Call Close %" value={pct(firstCallCloses, salesRecs.length) + "%"} />
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm">
            <button onClick={() => setDefsOpen(!defsOpen)} className="w-full flex items-center justify-between p-3 text-left">
              <span className="flex items-center gap-2 font-heading font-bold text-sm text-primary"><Info className="w-4 h-4" /> Definitions & Source Attribution</span>
              {defsOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>
            {defsOpen && (
              <div className="px-4 pb-4 text-xs text-muted-foreground space-y-1 border-t border-border/50">
                <p><strong className="text-foreground">Source Attribution:</strong> Leads are attributed by the Debrief <em>marketing_source</em> field (the customer's marketing/referral source). <em>self_gen_source</em> drills down Self-Gen. <em>result_source</em> (import batch) and <em>referral_source</em> (free-text detail) are not used for attribution.</p>
                <p><strong className="text-foreground">Unique Leads:</strong> Distinct Lead IDs; debriefs with no Lead ID are each counted once (fallback).</p>
                <p><strong className="text-foreground">Eligible Appointments:</strong> First Appointment + Rehash opportunities (attended + No See), excluding Reset Demos, Follow-Ups, DQ, and non-sales.</p>
                <p><strong className="text-foreground">Demo Rate:</strong> {DEMO_RATE_DEFINITION}</p>
                <p><strong className="text-foreground">No Demo Rate:</strong> {NO_DEMO_RATE_DEFINITION}</p>
                <p><strong className="text-foreground">No See Rate:</strong> {NO_SEE_RATE_DEFINITION}</p>
                <p><strong className="text-foreground">Two-Leg:</strong> {TWO_LEG_DEFINITION}</p>
                <p><strong className="text-foreground">Sales / Close Rate:</strong> Sales ÷ Demos. <strong className="text-foreground">Revenue:</strong> Sum of sale amounts for qualifying sales. <strong className="text-foreground">Average Sale:</strong> Revenue ÷ Sales.</p>
              </div>
            )}
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <ChartCard title="Appointment Volume by Source (Top 10)">
              <ResponsiveContainer width="100%" height={Math.max(220, volumeData.length * 34)}>
                <BarChart data={volumeData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="source" type="category" width={110} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="eligibleAppts" fill="#b45309" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Revenue by Source (Top 10)">
              <ResponsiveContainer width="100%" height={Math.max(220, revenueData.length * 34)}>
                <BarChart data={revenueData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={compactMoney} />
                  <YAxis dataKey="source" type="category" width={110} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => money(v)} />
                  <Bar dataKey="revenue" fill="#16a34a" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Demo Rate & Sales Rate by Source">
              <ResponsiveContainer width="100%" height={Math.max(240, rateData.length * 30)}>
                <BarChart data={rateData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} unit="%" />
                  <YAxis dataKey="source" type="category" width={110} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="demoRate" name="Demo Rate" fill="#1e293b" radius={[0, 4, 4, 0]} />
                  <Bar dataKey="salesRate" name="Sales Rate" fill="#16a34a" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Division Mix (Filtered)">
              <ResponsiveContainer width="100%" height={Math.max(220, divisionData.length * 34)}>
                <BarChart data={divisionData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="division" type="category" width={120} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="count" name="Appointments" fill="#0ea5e9" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <ChartCard title="Monthly Trend — Appointments, Demos, Sales & Revenue">
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={compactMoney} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar yAxisId="left" dataKey="appts" name="Appointments" fill="#94a3b8" radius={[4, 4, 0, 0]} />
                <Bar yAxisId="left" dataKey="demos" name="Demos" fill="#b45309" radius={[4, 4, 0, 0]} />
                <Bar yAxisId="left" dataKey="sales" name="Sales" fill="#16a34a" radius={[4, 4, 0, 0]} />
                <Line yAxisId="right" type="monotone" dataKey="revenue" name="Revenue" stroke="#1e293b" strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="p-3 border-b border-border/60">
              <h2 className="font-heading font-bold text-sm text-primary">Marketing Category Breakdown</h2>
              <p className="text-xs text-muted-foreground">One row per marketing category. Categories derived at runtime from the exact source. Reconciles to dashboard totals.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-max">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-left text-muted-foreground">
                    {["Category", "Records", "Eligible Appts", "Demos", "Demo Rate", "Sales", "Sales Rate", "Revenue", "Avg Sale"].map((h) => (
                      <th key={h} className="px-2.5 py-2 font-semibold whitespace-nowrap uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {catStats.map((r) => (
                    <tr key={r.category} className={`border-b border-border/60 hover:bg-secondary/30 ${r.isCleanup ? "bg-red-50/50" : (r.isSelfGen ? "bg-amber-50/50" : "")}`}>
                      <td className="px-2.5 py-2 font-bold text-primary whitespace-nowrap">{r.category}{r.isCleanup && <span className="ml-1 text-red-600" title="Unmapped sources — needs cleanup">⚠</span>}{r.isSelfGen && <span className="ml-1 text-amber-600" title="Valid self-generated lead — select a specific subtype going forward">⚠</span>}</td>
                      <td className="px-2.5 py-2">{r.count}</td>
                      <td className="px-2.5 py-2">{r.eligibleAppts}</td>
                      <td className="px-2.5 py-2">{r.demos}</td>
                      <td className="px-2.5 py-2">{r.demoRate}%</td>
                      <td className="px-2.5 py-2">{r.sales}</td>
                      <td className="px-2.5 py-2">{r.salesRate}%</td>
                      <td className="px-2.5 py-2">{money(r.revenue)}</td>
                      <td className="px-2.5 py-2">{r.sales ? money(r.avgSale) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-secondary/40 font-bold text-primary">
                    <td className="px-2.5 py-2">Total</td>
                    <td className="px-2.5 py-2">{catTotals.count}</td>
                    <td className="px-2.5 py-2">{catTotals.eligibleAppts}</td>
                    <td className="px-2.5 py-2">{catTotals.demos}</td>
                    <td className="px-2.5 py-2">{pct(catTotals.demos, catTotals.eligibleAppts - catStats.reduce((s, r) => s + r.noSee, 0))}%</td>
                    <td className="px-2.5 py-2">{catTotals.sales}</td>
                    <td className="px-2.5 py-2">{pct(catTotals.sales, catTotals.demos)}%</td>
                    <td className="px-2.5 py-2">{money(catTotals.revenue)}</td>
                    <td className="px-2.5 py-2">{money(Math.round(catTotals.revenue / Math.max(1, catTotals.sales)))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="p-3 border-b border-border/60">
              <h2 className="font-heading font-bold text-sm text-primary">Source Detail</h2>
              <p className="text-xs text-muted-foreground">One row per marketing source. Expand Self-Gen to view subsources. Rows reconcile to dashboard totals.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-max">
                <thead>
                  <tr className="border-b border-border bg-secondary/50 text-left text-muted-foreground">
                    {["Source", "Unique Leads", "Eligible Appts", "Demos", "Demo Rate", "No Demo", "No Demo Rate", "No See", "No See Rate", "2L/Eligible", "2L Rate", "Sales", "Sales Rate", "Revenue", "Avg Sale", "FCC"].map((h) => (
                      <th key={h} className="px-2.5 py-2 font-semibold whitespace-nowrap uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {srcStats.map((r) => (
                    <SourceRow key={r.source} r={r} expanded={expandedSrc === r.source} onToggle={() => setExpandedSrc(expandedSrc === r.source ? null : r.source)} />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-border bg-secondary/40 font-bold text-primary">
                    <td className="px-2.5 py-2">Total</td>
                    <td className="px-2.5 py-2">{totals.uniqueLeads}</td>
                    <td className="px-2.5 py-2">{totals.eligibleAppts}</td>
                    <td className="px-2.5 py-2">{totals.demos}</td>
                    <td className="px-2.5 py-2">{pct(totals.demos, totals.eligibleAppts - totals.noSee)}%</td>
                    <td className="px-2.5 py-2">{totals.noDemo}</td>
                    <td className="px-2.5 py-2">{pct(totals.noDemo, totals.demos)}%</td>
                    <td className="px-2.5 py-2">{totals.noSee}</td>
                    <td className="px-2.5 py-2">{pct(totals.noSee, totals.eligibleAppts)}%</td>
                    <td className="px-2.5 py-2">{totals.twoLeg}/{totals.twoLegDenom}</td>
                    <td className="px-2.5 py-2">{pct(totals.twoLeg, totals.twoLegDenom)}%</td>
                    <td className="px-2.5 py-2">{totals.sales}</td>
                    <td className="px-2.5 py-2">{pct(totals.sales, totals.demos)}%</td>
                    <td className="px-2.5 py-2">{money(totals.revenue)}</td>
                    <td className="px-2.5 py-2">{money(Math.round(totals.revenue / Math.max(1, totals.sales)))}</td>
                    <td className="px-2.5 py-2">{totals.firstCallClose}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SourceRow({ r, expanded, onToggle }) {
  return (
    <>
      <tr className="border-b border-border/60 hover:bg-secondary/30">
        <td className="px-2.5 py-2 font-bold text-primary whitespace-nowrap">
          <div className="flex items-center gap-1.5">
            {r.selfGenSubs && (
              <button onClick={onToggle} className="text-muted-foreground hover:text-accent">
                {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
            )}
            {r.source}{r.isUnassigned && <span className="ml-1 text-amber-600" title="Unassigned source">⚠</span>}
          </div>
        </td>
        <td className="px-2.5 py-2">{r.uniqueLeads}{r.missingLeadIds > 0 && <span className="text-amber-600 text-[10px] ml-1">({r.missingLeadIds} no ID)</span>}</td>
        <td className="px-2.5 py-2">{r.eligibleAppts}</td>
        <td className="px-2.5 py-2">{r.demos}</td>
        <td className="px-2.5 py-2">{r.demoRate}%</td>
        <td className="px-2.5 py-2">{r.noDemo}</td>
        <td className="px-2.5 py-2">{r.noDemoRate}%</td>
        <td className="px-2.5 py-2">{r.noSee}</td>
        <td className="px-2.5 py-2">{r.noSeeRate}%</td>
        <td className="px-2.5 py-2">{r.twoLeg}/{r.twoLegDenom}</td>
        <td className="px-2.5 py-2">{r.twoLegDenom > 0 ? r.twoLegRate + "%" : "—"}</td>
        <td className="px-2.5 py-2">{r.sales}</td>
        <td className="px-2.5 py-2">{r.salesRate}%</td>
        <td className="px-2.5 py-2">{money(r.revenue)}</td>
        <td className="px-2.5 py-2">{r.sales ? money(r.avgSale) : "—"}</td>
        <td className="px-2.5 py-2">{r.firstCallClose}</td>
      </tr>
      {expanded && r.selfGenSubs && r.selfGenSubs.map((s) => (
        <tr key={s.sub} className="border-b border-border/40 bg-secondary/20">
          <td className="px-2.5 py-1.5 pl-8 text-muted-foreground whitespace-nowrap">↳ {s.sub}</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">{s.eligibleAppts}</td>
          <td className="px-2.5 py-1.5">{s.demos}</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">{s.sales}</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">{money(s.revenue)}</td>
          <td className="px-2.5 py-1.5">—</td>
          <td className="px-2.5 py-1.5">—</td>
        </tr>
      ))}
    </>
  );
}

function FilterField({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function ChartCard({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <h2 className="font-heading font-bold text-sm text-primary mb-3">{title}</h2>
      {children}
    </div>
  );
}