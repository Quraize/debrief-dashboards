/**
 * The marketing dashboard's "From JobProgress (CRM)" section: leads by
 * source as the office recorded them at intake, and the appointments, demos
 * and sales those leads produced — the top of the funnel the debrief form
 * never sees.
 */
import KpiCard from "@/components/KpiCard";
import { JpSectionShell, useJpMirror, useJpCustomers } from "@/components/JpCrmSection";
import { jpMarketingStats, JP_MARKETING_DEFINITIONS as D, UNKNOWN_SOURCE } from "@allied/shared/jpMarketing";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { AlertTriangle } from "lucide-react";

function money(v) { return "$" + Math.round(Number(v) || 0).toLocaleString(); }
const pctOr = (d, v) => (d > 0 ? v + "%" : "—");

export default function JpMarketingSection({ filter, cs, ce }) {
  const { jpAppointments, jpJobs, isLoading: mirrorLoading } = useJpMirror();
  const { customers, isLoading: customersLoading } = useJpCustomers();
  if (mirrorLoading || customersLoading) return null;

  if (customers.length === 0) {
    return (
      <JpSectionShell subtitle="Lead sources as recorded on every JobProgress customer at intake.">
        <div className="bg-white rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No CRM customers synced yet. An admin can run <span className="font-semibold">Sync Customers</span> from the
          JobProgress Sync page; afterwards it runs automatically four times a day.
        </div>
      </JpSectionShell>
    );
  }

  const s = jpMarketingStats(customers, jpAppointments, jpJobs, filter, cs, ce);
  const cards = [
    { label: "CRM Leads", value: s.leads, accent: true, title: D.leads },
    { label: "Appointments Run", value: s.appointments, title: D.appointments },
    { label: "Lead → Appt", value: pctOr(s.leads, s.leadToApptRate), title: D.leadToAppt },
    { label: "Demos", value: s.demos, title: D.demos },
    { label: "Sales", value: s.sales, title: D.sales },
    { label: "Sales %", value: pctOr(s.demos, s.closeRate), title: "Sales ÷ demos." },
    { label: "Sales $ (CRM)", value: money(s.salesAmount), title: D.salesAmount
      + (s.salesMissingAmount > 0 ? ` ${s.salesMissingAmount} sale(s) have no contract value in the CRM yet.` : ""),
      rating: s.salesMissingAmount > 0 ? "yellow" : null },
    { label: "Customer Referrals", value: s.customerReferrals, title: D.customerReferrals },
    { label: "Unknown Source", value: s.unknownLeads, title: D.unknownSource, rating: s.unknownLeads > 0 ? "yellow" : null },
    { label: "Note-only Source", value: s.noteLeads, title: D.noteSource, rating: s.noteLeads > 0 ? "yellow" : null },
  ];

  const topSources = s.bySource.slice(0, 12).map((r) => ({ ...r, name: r.label.length > 26 ? r.label.slice(0, 25) + "…" : r.label }));

  return (
    <JpSectionShell subtitle={
      "Lead sources as recorded on every JobProgress customer at intake — the same referral list the debrief dropdown uses. "
      + "Leads count by the date the customer was created; appointments, demos and sales by appointment date, attributed through the customer."
    }>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {cards.map((c) => <KpiCard key={c.label} label={c.label} value={c.value} title={c.title} accent={c.accent} rating={c.rating ?? null} />)}
      </div>

      {s.unmappedSources.length > 0 && (
        <div className="flex items-start gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{D.unmapped} They roll up to Other / Needs Cleanup until mapped: <strong>{s.unmappedSources.join(", ")}</strong></span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <h3 className="font-heading font-bold text-sm text-primary mb-3">CRM Leads by Source (Top 12)</h3>
          <ResponsiveContainer width="100%" height={Math.max(220, topSources.length * 26)}>
            <BarChart data={topSources} layout="vertical" margin={{ left: 10, right: 20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis dataKey="name" type="category" width={170} tick={{ fontSize: 10 }} />
              <Tooltip />
              <Bar dataKey="leads" name="Leads" fill="#0369a1" radius={[0, 4, 4, 0]} />
              <Bar dataKey="sales" name="Sales" fill="#16a34a" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <h3 className="font-heading font-bold text-sm text-primary mb-3">CRM Leads by Month</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={s.leadsByMonth}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="leads" name="Leads" fill="#0369a1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <FunnelTable title="CRM Marketing Category Breakdown" rows={s.byCategory} total={s} keyLabel="Category"
        subtitle="One row per marketing category, derived from the CRM referral source with the dashboard's category map." />
      <FunnelTable title="CRM Source Detail" rows={s.bySource} total={s} keyLabel="Source"
        subtitle="Every referral source with a lead or an appointment in the period." flagUnknown />
    </JpSectionShell>
  );
}

const COLS = [
  ["leads", "Leads"], ["appointments", "Appts Run"], ["leadToApptRate", "Lead → Appt", true], ["noShows", "No See"],
  ["demos", "Demos"], ["demoRate", "Demo %", true], ["sales", "Sales"], ["closeRate", "Sales %", true],
  ["leadToSaleRate", "Lead → Sale", true], ["salesAmount", "Sales $", false, true], ["avgSale", "Avg Sale", false, true],
];
const DENOM = { leadToApptRate: (r) => r.leads, demoRate: (r) => r.appointments, closeRate: (r) => r.demos, leadToSaleRate: (r) => r.leads };

function FunnelTable({ title, subtitle, rows, total, keyLabel, flagUnknown }) {
  if (rows.length === 0) return null;
  const cell = (r, key, isRate, isMoney) => {
    if (isMoney) return r[key] ? money(r[key]) : "—";
    if (isRate) return DENOM[key](r) > 0 ? r[key] + "%" : "—";
    return r[key] || "";
  };
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <div className="p-3 border-b border-border/60">
        <h3 className="font-heading font-bold text-sm text-primary">{title}</h3>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-max">
          <thead>
            <tr className="border-b border-border bg-secondary/50 text-left text-muted-foreground">
              <th className="px-2.5 py-2 font-semibold whitespace-nowrap uppercase tracking-wide">{keyLabel}</th>
              {COLS.map(([key, label]) => <th key={key} className="px-2.5 py-2 font-semibold whitespace-nowrap uppercase tracking-wide text-center">{label}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className="border-b border-border/50">
                <td className="px-2.5 py-2 font-bold text-primary whitespace-nowrap">
                  {r.label}
                  {flagUnknown && r.label === UNKNOWN_SOURCE && <span className="ml-1 text-amber-600" title={D.unknownSource}>⚠</span>}
                </td>
                {COLS.map(([key, , isRate, isMoney]) => <td key={key} className="px-2.5 py-2 text-center">{cell(r, key, isRate, isMoney)}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="bg-secondary/40 font-bold">
              <td className="px-2.5 py-2">Total</td>
              {COLS.map(([key, , isRate, isMoney]) => <td key={key} className="px-2.5 py-2 text-center">{cell(total, key, isRate, isMoney)}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
