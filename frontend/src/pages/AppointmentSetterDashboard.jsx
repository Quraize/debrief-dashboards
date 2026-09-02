import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import DateRangeFilter from "@/components/DateRangeFilter";
import DashboardSwitcher from "@/components/DashboardSwitcher";
import KpiCard from "@/components/KpiCard";
import RatingBadge from "@/components/RatingBadge";
import { setterStats, filterByDate, safeNum, DEMO_RATE_DEFINITION, NO_DEMO_RATE_DEFINITION, NO_SEE_RATE_DEFINITION, RESET_RATE_DEFINITION, RESET_RECOVERY_DEFINITION, LEGACY_DEMO_RATE_DEFINITION, TWO_LEG_DEFINITION } from "@allied/shared/kpi";
import { nonInsuranceDebriefs } from "@allied/shared/insurance";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, PieChart, Pie, Legend } from "recharts";
import { Loader2 } from "lucide-react";
import { JpSetterSection, DebriefSectionHeader } from "@/components/JpCrmSection";

const COLORS = { Excellent: "#16a34a", Good: "#f59e0b", Poor: "#dc2626", "No Data": "#94a3b8" };

function twoLegColor(pctVal, hasDenom) {
  if (!hasDenom) return COLORS["No Data"];
  return pctVal >= 90 ? COLORS.Excellent : pctVal >= 80 ? COLORS.Good : COLORS.Poor;
}

function serColor(ser, hasDemos) {
  if (!hasDemos) return COLORS["No Data"];
  return ser >= 135 ? COLORS.Excellent : ser >= 120 ? COLORS.Good : COLORS.Poor;
}

function cellClass(val, excellent, good) {
  if (val === 0) return "px-3 py-2 whitespace-nowrap font-medium text-muted-foreground";
  return val >= excellent ? "px-3 py-2 whitespace-nowrap font-bold text-green-700 bg-green-50" : val >= good ? "px-3 py-2 whitespace-nowrap font-bold text-amber-700 bg-amber-50" : "px-3 py-2 whitespace-nowrap font-bold text-red-700 bg-red-50";
}

export default function AppointmentSetterDashboard() {
  const [filter, setFilter] = useState("This Month");
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");

  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const filtered = filterByDate(nonInsuranceDebriefs(debriefs), "appointment_date", filter, cs, ce);
  const stats = setterStats(filtered, appointments);

  const teamRevenue = stats.reduce((s, r) => s + r.revenue, 0);
  const teamDemos = stats.reduce((s, r) => s + r.demos, 0);
  const teamTwoLeg = stats.reduce((s, r) => s + r.twoLeg, 0);
  const teamTwoLegDenom = stats.reduce((s, r) => s + r.twoLegDenom, 0);
  const teamTwoLegPct = teamTwoLegDenom > 0 ? Math.round((teamTwoLeg / teamTwoLegDenom) * 100) : 0;
  const teamTwoLegRating = teamTwoLegDenom === 0 ? "No Data" : teamTwoLegPct >= 90 ? "Excellent" : teamTwoLegPct >= 80 ? "Good" : "Poor";

  const teamAqDemos = stats.reduce((s, r) => s + safeNum(r.aqDemos), 0);
  const teamAqOpp = stats.reduce((s, r) => s + safeNum(r.aqOpportunities), 0);
  const teamAqAttended = stats.reduce((s, r) => s + safeNum(r.aqAttended), 0);
  const teamAqNoDemo = stats.reduce((s, r) => s + safeNum(r.aqNoDemo), 0);
  const teamAqNoSee = stats.reduce((s, r) => s + safeNum(r.aqNoSee), 0);
  const teamAqResetNeeded = stats.reduce((s, r) => s + safeNum(r.aqResetNeeded), 0);
  const teamAqCompletedReset = stats.reduce((s, r) => s + safeNum(r.aqCompletedResetDemo), 0);
  const teamDemoRate = teamAqOpp > 0 ? Math.round((teamAqDemos / teamAqOpp) * 100) : 0;
  const teamNoDemoRate = teamAqAttended > 0 ? Math.round((teamAqNoDemo / teamAqAttended) * 100) : 0;
  const teamNoSeeRate = teamAqOpp > 0 ? Math.round((teamAqNoSee / teamAqOpp) * 100) : 0;
  const teamResetRate = teamAqOpp > 0 ? Math.round((teamAqResetNeeded / teamAqOpp) * 100) : 0;
  const teamResetRecovery = teamAqResetNeeded > 0 ? Math.round((teamAqCompletedReset / teamAqResetNeeded) * 100) : 0;

  const twoLegData = [...stats].sort((a, b) => b.twoLegPctNum - a.twoLegPctNum).map((s) => ({ name: s.name, pct: s.twoLegPctNum, hasDenom: s.twoLegDenom > 0 }));
  const serData = [...stats].sort((a, b) => b.ser - a.ser).map((s) => ({ name: s.name, ser: s.ser, hasDemos: s.demos > 0 }));
  const distribution = [
    { name: "Excellent (≥90%)", value: stats.filter((r) => r.twoLegPctNum >= 90).length, color: COLORS.Excellent },
    { name: "Good (80–89%)", value: stats.filter((r) => r.twoLegPctNum >= 80 && r.twoLegPctNum < 90).length, color: COLORS.Good },
    { name: "Poor (<80%)", value: stats.filter((r) => r.twoLegDenom > 0 && r.twoLegPctNum < 80).length, color: COLORS.Poor },
  ].filter((d) => d.value > 0);

  return (
    <div className="space-y-4">
      <DashboardSwitcher />
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Call Center / Appointment Setters</h1>
        <p className="text-sm text-muted-foreground">Per-setter performance — Two-Leg % is the key efficiency metric for call centers.</p>
      </div>

      <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />

      <div className="space-y-2">
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="font-semibold text-muted-foreground self-center">Two-Leg % Standards:</span>
          <span className="bg-green-100 text-green-700 font-bold px-2 py-0.5 rounded-full">Excellent ≥ 90%</span>
          <span className="bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded-full">Good 80–89%</span>
          <span className="bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded-full">Poor &lt; 80%</span>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="font-semibold text-muted-foreground self-center">SER Standards:</span>
          <span className="bg-green-100 text-green-700 font-bold px-2 py-0.5 rounded-full">Excellent ≥ 135</span>
          <span className="bg-amber-100 text-amber-700 font-bold px-2 py-0.5 rounded-full">Good 120–134</span>
          <span className="bg-red-100 text-red-700 font-bold px-2 py-0.5 rounded-full">Poor ≤ 119</span>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : stats.length === 0 ? (
        <div className="text-center text-muted-foreground py-8 text-sm">No debriefs in this period.</div>
      ) : (
        <>
          <DebriefSectionHeader />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <KpiCard label="Team Two-Leg %" value={teamTwoLegPct + "%"} accent />
            <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Two-Leg Rating</div>
              <RatingBadge rating={teamTwoLegRating} />
            </div>
            <KpiCard label="Total Leads" value={stats.reduce((s, r) => s + r.count, 0)} />
            <KpiCard label="Total Demos" value={teamDemos} />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-3">
            <KpiCard label="Team Demo Rate" value={teamDemoRate + "%"} accent />
            <KpiCard label="No Demo" value={teamAqNoDemo} />
            <KpiCard label="No Demo Rate" value={teamNoDemoRate + "%"} />
            <KpiCard label="No See" value={teamAqNoSee} />
            <KpiCard label="No See Rate" value={teamNoSeeRate + "%"} />
            <KpiCard label="Reset Needed" value={teamAqResetNeeded} />
            <KpiCard label="Reset Rate" value={teamResetRate + "%"} />
            <KpiCard label="Completed Reset Demos" value={teamAqCompletedReset} />
            <KpiCard label="Reset Recovery Rate" value={teamResetRecovery + "%"} />
          </div>

          <div className="bg-secondary/40 rounded-lg p-3 text-xs text-muted-foreground space-y-1">
            <div><strong className="text-foreground">Demo Rate:</strong> {DEMO_RATE_DEFINITION}</div>
            <div><strong className="text-foreground">No Demo Rate:</strong> {NO_DEMO_RATE_DEFINITION}</div>
            <div><strong className="text-foreground">No See Rate:</strong> {NO_SEE_RATE_DEFINITION}</div>
            <div><strong className="text-foreground">Reset Rate:</strong> {RESET_RATE_DEFINITION}</div>
            <div><strong className="text-foreground">Reset Recovery Rate:</strong> {RESET_RECOVERY_DEFINITION}</div>
            <div><strong className="text-foreground">Legacy Overall Demo Rate:</strong> {LEGACY_DEMO_RATE_DEFINITION}</div>
            <div><strong className="text-foreground">Two-Leg %:</strong> {TWO_LEG_DEFINITION}</div>
          </div>

          <div className="grid lg:grid-cols-2 gap-4">
            <ChartCard title="Two-Leg % by Setter">
              <ResponsiveContainer width="100%" height={Math.max(200, twoLegData.length * 40)}>
                <BarChart data={twoLegData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => v + "%"} />
                  <Bar dataKey="pct" radius={[0, 4, 4, 0]}>
                    {twoLegData.map((d, i) => <Cell key={i} fill={twoLegColor(d.pct, d.hasDenom)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="SER by Setter">
              <ResponsiveContainer width="100%" height={Math.max(200, serData.length * 40)}>
                <BarChart data={serData} layout="vertical" margin={{ left: 10, right: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" horizontal={false} />
                  <XAxis type="number" tick={{ fontSize: 11 }} />
                  <YAxis dataKey="name" type="category" width={90} tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="ser" radius={[0, 4, 4, 0]}>
                    {serData.map((d, i) => <Cell key={i} fill={serColor(d.ser, d.hasDemos)} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Two-Leg % Distribution">
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={distribution} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={{ fontSize: 11 }}>
                    {distribution.map((d, i) => <Cell key={i} fill={d.color} />)}
                  </Pie>
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>

          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-max">
                <thead>
                  <tr className="border-b border-border bg-secondary/50">
                    {["Setter", "Two-Leg %", "Rating", "Leads", "Demos", "Demo Rate", "No Demo", "No Demo %", "No See", "No See %", "Reset Need", "Reset Rec %", "2-Leg", "Sales", "Sales %", "Revenue", "Avg Job", "SER", "1st Call %", "Missing"].map((h) => (
                      <th key={h} className="text-left font-semibold text-muted-foreground px-3 py-2 whitespace-nowrap text-xs uppercase tracking-wide">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.name} className="border-b border-border/60 hover:bg-secondary/30">
                      <td className="px-3 py-2 whitespace-nowrap font-bold text-primary">{s.name}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-bold text-base" style={{ color: twoLegColor(s.twoLegPctNum, s.twoLegDenom > 0) }}>{s.twoLegPct}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <RatingBadge rating={s.twoLegDenom === 0 ? "No Data" : s.twoLegPctNum >= 90 ? "Excellent" : s.twoLegPctNum >= 80 ? "Good" : "Poor"} />
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.count}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.demos}</td>
                      <td className={cellClass(s.demoRateNum, 80, 60)}>{s.demoRatePct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.aqNoDemo}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.noDemoRatePct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.aqNoSee}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.noSeeRatePct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.aqResetNeeded}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.resetRecoveryRatePct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.twoLeg}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.sales}</td>
                      <td className={cellClass(s.closeRateNum, 40, 30)}>{s.salesPct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">${s.revenue.toLocaleString()}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.avgJob}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-bold" style={{ color: serColor(s.ser, s.demos > 0) }}>{s.ser}</td>
                      <td className={cellClass(s.firstCallClosePctNum, 30, 15)}>{s.firstCallClosePct}</td>
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{s.missingDebriefs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </>
      )}

      {/* Independent of the debrief section by design: renders even when the
          period has no debriefs at all — that gap is exactly what it shows. */}
      <JpSetterSection filter={filter} cs={cs} ce={ce} debriefs={debriefs} />
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