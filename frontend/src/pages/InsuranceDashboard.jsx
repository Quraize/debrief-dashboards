import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import KpiCard from "@/components/KpiCard";
import { TRADES, INSURANCE_OUTCOMES } from "@allied/shared/constants";
import {
  computeInsuranceKPIs, insuranceFunnelData, insuranceMonthlyTrend,
  insuranceStatusBreakdown, insuranceTradeMix, insuranceSourceBreakdown,
  insuranceRepTable, insuranceDebriefs
} from "@allied/shared/insurance";
import { filterByDate } from "@allied/shared/kpi";
import { Shield, Loader2, AlertTriangle } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, LineChart, Line, CartesianGrid, Legend
} from "recharts";

const PIE_COLORS = ["#0f172a", "#ea580c", "#0ea5e9", "#16a34a", "#eab308", "#dc2626", "#7c3aed", "#64748b"];

export default function InsuranceDashboard() {
  const [filter, setFilter] = useState("This Month");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [rep, setRep] = useState("");
  const [setter, setSetter] = useState("");
  const [trade, setTrade] = useState("");
  const [source, setSource] = useState("");
  const [status, setStatus] = useState("");

  const { data: debriefs = [], isLoading } = useQuery({
    queryKey: ["debriefs"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });
  const { data: appointments = [] } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-created_date", 500)
  });

  // Apply person/trade/source/status filters on top of date range
  const filteredDb = useMemo(() => {
    let result = filterByDate(insuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
    if (rep) result = result.filter((d) => d.sales_rep === rep);
    if (setter) result = result.filter((d) => d.appointment_setter === setter);
    if (trade) result = result.filter((d) => d.trade === trade);
    if (source) result = result.filter((d) => (d.marketing_source || "") === source);
    if (status) result = result.filter((d) => d.insurance_outcome === status);
    return result;
  }, [debriefs, filter, cs, ce, rep, setter, trade, source, status]);

  // Use filtered debriefs for KPI computation; pass empty appointments since we filter at debrief level
  const { kpis, warnings } = useMemo(
    () => computeInsuranceKPIs(filteredDb, [], "All", "", ""),
    [filteredDb]
  );

  const funnel = useMemo(() => insuranceFunnelData(filteredDb, [], "All", "", ""), [filteredDb]);
  const trend = useMemo(() => insuranceMonthlyTrend(filteredDb, "All", "", ""), [filteredDb]);
  const statusData = useMemo(() => insuranceStatusBreakdown(filteredDb, "All", "", ""), [filteredDb]);
  const tradeData = useMemo(() => insuranceTradeMix(filteredDb, "All", "", ""), [filteredDb]);
  const sourceData = useMemo(() => insuranceSourceBreakdown(filteredDb, "All", "", ""), [filteredDb]);
  const repTable = useMemo(() => insuranceRepTable(filteredDb, "All", "", ""), [filteredDb]);

  // Unique filter options from insurance debriefs
  const reps = useMemo(() => [...new Set(insuranceDebriefs(debriefs).map((d) => d.sales_rep).filter(Boolean))], [debriefs]);
  const setters = useMemo(() => [...new Set(insuranceDebriefs(debriefs).map((d) => d.appointment_setter).filter(Boolean))], [debriefs]);
  const sources = useMemo(() => [...new Set(insuranceDebriefs(debriefs).map((d) => d.marketing_source).filter(Boolean))], [debriefs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Shield className="w-6 h-6 text-accent" />
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Insurance Dashboard</h1>
          <p className="text-sm text-muted-foreground">Insurance division efficiency — Rodney Webb workbook KPIs.</p>
        </div>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      {/* Filters */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        <FilterSelect label="Rep" value={rep} onChange={setRep} options={reps} />
        <FilterSelect label="Setter" value={setter} onChange={setSetter} options={setters} />
        <FilterSelect label="Trade" value={trade} onChange={setTrade} options={TRADES} />
        <FilterSelect label="Source" value={source} onChange={setSource} options={sources} />
        <FilterSelect label="Status" value={status} onChange={setStatus} options={INSURANCE_OUTCOMES} />
      </div>

      {warnings.length > 0 && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-3 space-y-1">
          {warnings.map((w, i) => (
            <div key={i} className="flex items-start gap-2 text-sm text-red-700">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{w}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {kpis.map((k) => <KpiCard key={k.label} label={k.label} value={k.value} rating={k.rating} />)}
          </div>

          {/* Funnel */}
          <ChartCard title="Insurance Funnel">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={funnel} layout="vertical" margin={{ left: 20 }}>
                <XAxis type="number" />
                <YAxis dataKey="stage" type="category" width={100} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="value" fill="#ea580c" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Monthly trend */}
            <ChartCard title="Monthly Trend">
              {trend.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={250}>
                  <LineChart data={trend}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend />
                    <Line type="monotone" dataKey="demos" stroke="#0f172a" strokeWidth={2} />
                    <Line type="monotone" dataKey="contingencies" stroke="#ea580c" strokeWidth={2} />
                    <Line type="monotone" dataKey="contracts" stroke="#16a34a" strokeWidth={2} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Status breakdown */}
            <ChartCard title="Status Breakdown">
              {statusData.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                      {statusData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Trade mix */}
            <ChartCard title="Trade Mix">
              {tradeData.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={250}>
                  <PieChart>
                    <Pie data={tradeData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label>
                      {tradeData.map((_, i) => <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </ChartCard>

            {/* Marketing source breakdown */}
            <ChartCard title="Marketing Source Breakdown">
              {sourceData.length === 0 ? <Empty /> : (
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart data={sourceData} margin={{ left: -10 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={60} />
                    <YAxis tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Bar dataKey="value" fill="#0f172a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </ChartCard>
          </div>

          {/* Rep table */}
          <div className="bg-white rounded-xl border border-border p-4 shadow-sm overflow-x-auto">
            <h2 className="font-heading font-bold text-sm text-primary mb-3">Rep Performance</h2>
            {repTable.length === 0 ? (
              <p className="text-sm text-muted-foreground">No insurance debriefs in range.</p>
            ) : (
              <table className="text-xs min-w-full">
                <thead>
                  <tr className="bg-secondary/50 text-left">
                    <th className="px-2 py-2 font-semibold text-muted-foreground">Rep</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Count</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Demos</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Contingencies</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Upgrades</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Contracts</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Upgrade Rev</th>
                    <th className="px-2 py-2 font-semibold text-muted-foreground text-right">Job Price</th>
                  </tr>
                </thead>
                <tbody>
                  {repTable.map((r) => (
                    <tr key={r.rep} className="border-b border-border/60">
                      <td className="px-2 py-2 font-semibold text-primary">{r.rep}</td>
                      <td className="px-2 py-2 text-right">{r.count}</td>
                      <td className="px-2 py-2 text-right">{r.demos}</td>
                      <td className="px-2 py-2 text-right">{r.contingencies}</td>
                      <td className="px-2 py-2 text-right">{r.upgrades}</td>
                      <td className="px-2 py-2 text-right">{r.contracts}</td>
                      <td className="px-2 py-2 text-right">${r.upgradeRevenue.toLocaleString()}</td>
                      <td className="px-2 py-2 text-right">${r.jobPrice.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <label className="block space-y-0.5">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-input rounded-lg px-2 py-2 text-sm font-medium bg-white"
      >
        <option value="">All</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
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

function Empty() {
  return <div className="h-[250px] flex items-center justify-center text-sm text-muted-foreground">No data in range.</div>;
}