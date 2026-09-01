import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import KpiCard from "@/components/KpiCard";
import { computeKPIs, filterByDate, isSale } from "@allied/shared/kpi";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { nonInsuranceDebriefs, nonInsuranceAppointments } from "@allied/shared/insurance";
import { DEMO_OUTCOMES, SALE_CANCELLATION_OUTCOME, SALE_CREDIT_DECLINE_OUTCOME } from "@allied/shared/constants";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, LineChart, Line, CartesianGrid, Legend, PieChart, Pie, Cell, ComposedChart, LabelList } from "recharts";
import { Loader2 } from "lucide-react";
import { JpKpiSection } from "@/components/JpCrmSection";

const DM_COLORS = { "Two-Leg": "#16a34a", "One-Leg": "#f59e0b", "N/A": "#94a3b8", "Unassigned": "#94a3b8" };
const PERIODS = ["Week", "Month", "Year"];

export default function KpiDashboard() {
  const [filter, setFilter] = useState("This Month");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [revenuePeriod, setRevenuePeriod] = useState("Week");
  const [lossPeriod, setLossPeriod] = useState("Month");

  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const retailDb = nonInsuranceDebriefs(debriefs);
  const kpis = computeKPIs(retailDb, salesAppointmentsOnly(nonInsuranceAppointments(appointments)), filter, cs, ce);
  const fdb = filterByDate(retailDb, "appointment_date", filter, cs, ce);
  const weekly = weeklyTrends(fdb);
  const decisionMaker = aggregate(fdb.filter((d) => d.decision_maker_status), "decision_maker_status");
  const revenueData = revenueByPeriod(fdb, revenuePeriod);
  const lossData = lossByPeriod(fdb, lossPeriod);
  const outcomes = outcomeBreakdown(fdb);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">KPI Dashboard</h1>
        <p className="text-sm text-muted-foreground">Performance across the selected period.</p>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {kpis.map((k, i) => <KpiCard key={k.label} label={k.label} value={k.value} accent={i < 4} rating={k.rating} />)}
          </div>

          <ChartCard title="Sales Revenue" toggle={revenuePeriod} setToggle={setRevenuePeriod}>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={revenueData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => "$" + (v / 1000).toFixed(0) + "k"} />
                <Tooltip formatter={(v) => "$" + Number(v).toLocaleString()} />
                <Bar dataKey="revenue" fill="#16a34a" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          <div className="grid lg:grid-cols-2 gap-4">
            <ChartCard title="Demo % by Week">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={weekly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="demoPct" stroke="#b45309" strokeWidth={2} name="Demo %" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Sales % by Week">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={weekly}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Line type="monotone" dataKey="salesPct" stroke="#1e293b" strokeWidth={2} name="Sales %" />
                </LineChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Decision Maker Status">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={decisionMaker} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={({ percent }) => `${(percent * 100).toFixed(0)}%`}>
                    {decisionMaker.map((d, i) => <Cell key={i} fill={DM_COLORS[d.name] || "#94a3b8"} />)}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Cancellations & Credit Declines" toggle={lossPeriod} setToggle={setLossPeriod}>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={lossData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} tickFormatter={(v) => "$" + (v / 1000).toFixed(0) + "k"} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="cancellations" fill="#dc2626" radius={[4, 4, 0, 0]} />
                  <Bar yAxisId="left" dataKey="creditDeclines" fill="#7c3aed" radius={[4, 4, 0, 0]} />
                  <Line yAxisId="right" type="monotone" dataKey="cancellationAmount" stroke="#dc2626" strokeWidth={2} name="Cancel $" dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="creditDeclineAmount" stroke="#7c3aed" strokeWidth={2} name="Credit $" dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <ChartCard title="Debrief Outcomes Breakdown">
            <ResponsiveContainer width="100%" height={Math.max(200, outcomes.length * 36)}>
              <BarChart data={outcomes} layout="vertical" margin={{ left: 20 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} />
                <YAxis dataKey="name" type="category" width={180} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => v + " debriefs"} />
                <Bar dataKey="value" fill="#b45309" radius={[0, 4, 4, 0]}>
                  <LabelList dataKey="percent" position="right" formatter={(v) => v + "%"} style={{ fontSize: 10, fill: "#64748b" }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Coverage matching uses ALL debriefs (insurance included) — a JP
              insurance appointment with an insurance debrief is covered. */}
          <JpKpiSection filter={filter} cs={cs} ce={ce} debriefs={debriefs} />
        </>
      )}
    </div>
  );
}

function ChartCard({ title, children, toggle, setToggle }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-heading font-bold text-sm text-primary">{title}</h2>
        {toggle && setToggle && (
          <div className="flex gap-1">
            {PERIODS.map((p) => (
              <button key={p} onClick={() => setToggle(p)}
                className={`text-xs px-2 py-1 rounded-md font-semibold ${toggle === p ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {p}
              </button>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function periodKey(dateStr, period) {
  const dt = new Date(dateStr + "T00:00:00");
  if (period === "Year") return { key: String(dt.getFullYear()), label: String(dt.getFullYear()) };
  if (period === "Month") return { key: dt.toISOString().slice(0, 7), label: dt.toLocaleDateString("en-US", { month: "short", year: "2-digit" }) };
  const day = (dt.getDay() + 6) % 7;
  const ws = new Date(dt); ws.setDate(dt.getDate() - day);
  return { key: ws.toISOString().slice(0, 10), label: ws.toLocaleDateString("en-US", { month: "short", day: "numeric" }) };
}

function revenueByPeriod(debriefs, period) {
  const map = {};
  debriefs.forEach((d) => {
    if (!d.appointment_date || !isSale(d)) return;
    const { key, label } = periodKey(d.appointment_date, period);
    if (!map[key]) map[key] = { label, revenue: 0 };
    map[key].revenue += Number(d.sale_amount) || 0;
  });
  return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
}

function lossByPeriod(debriefs, period) {
  const map = {};
  debriefs.forEach((d) => {
    if (!d.appointment_date) return;
    const { key, label } = periodKey(d.appointment_date, period);
    if (!map[key]) map[key] = { label, cancellations: 0, cancellationAmount: 0, creditDeclines: 0, creditDeclineAmount: 0 };
    const g = map[key];
    if (d.appointment_outcome === SALE_CANCELLATION_OUTCOME) { g.cancellations++; g.cancellationAmount += Number(d.sale_amount) || 0; }
    if (d.appointment_outcome === SALE_CREDIT_DECLINE_OUTCOME) { g.creditDeclines++; g.creditDeclineAmount += Number(d.sale_amount) || 0; }
  });
  return Object.values(map).sort((a, b) => a.label.localeCompare(b.label));
}

function outcomeBreakdown(debriefs) {
  const total = debriefs.length;
  const map = {};
  debriefs.forEach((d) => {
    const k = d.appointment_outcome || "Unassigned";
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map)
    .map(([name, value]) => ({ name, value, percent: total > 0 ? Math.round((value / total) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
}

function aggregate(items, field) {
  const map = {};
  items.forEach((d) => {
    const k = d[field] || "Unassigned";
    map[k] = (map[k] || 0) + 1;
  });
  return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

function weeklyTrends(debriefs) {
  const map = {};
  debriefs.forEach((d) => {
    if (!d.appointment_date) return;
    const dt = new Date(d.appointment_date + "T00:00:00");
    const day = (dt.getDay() + 6) % 7;
    const ws = new Date(dt); ws.setDate(dt.getDate() - day);
    const key = ws.toISOString().slice(5, 10);
    if (!map[key]) map[key] = { week: key, total: 0, demos: 0, sales: 0, revenue: 0 };
    const g = map[key];
    g.total++;
    if (DEMO_OUTCOMES.includes(d.appointment_outcome)) g.demos++;
    if (isSale(d)) { g.sales++; g.revenue += Number(d.sale_amount) || 0; }
  });
  return Object.values(map).map((g) => ({
    ...g,
    demoPct: g.demos > 0 ? Math.round((g.demos / g.total) * 100) : 0,
    salesPct: g.sales > 0 && g.demos > 0 ? Math.round((g.sales / g.demos) * 100) : 0
  })).sort((a, b) => a.week.localeCompare(b.week));
}