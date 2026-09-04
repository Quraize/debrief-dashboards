/**
 * "From JobProgress (CRM)" dashboard sections.
 *
 * Everything below the divider these components render comes from the
 * jp_appointment / jp_job mirror tables the scheduled sync maintains — the
 * CRM's own record, deliberately separate from the rep-submitted debriefs the
 * rest of each dashboard is built on. The two disagree by design: JobProgress
 * sees every appointment on the calendar; debriefs only exist when someone
 * files one (August 2026: 119 CRM appointments vs 57 debriefed opportunities).
 *
 * All aggregation logic lives in @allied/shared/jpStats; this file is layout.
 */
import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import KpiCard from "@/components/KpiCard";
import {
  jpAppointmentStats, jpTwoLegStats, jpRevenueStats, jpSetterStats, jpRepStats,
  jpDebriefCoverage, JP_SOURCE_NOTE, JP_TWO_LEG_DEFINITION, JP_REVENUE_DEFINITION,
  JP_COVERAGE_DEFINITION,
  JP_APPOINTMENTS_DEFINITION,
  JP_AWAITING_DEFINITION,
  AWAITING_RESULT_DAYS,
} from "@allied/shared/jpStats";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Database, ClipboardList } from "lucide-react";

// The mirror only changes when the sync runs (4x/day), so there is no reason
// to refetch it on every mount the way the debrief queries do.
const JP_STALE_MS = 5 * 60 * 1000;

export function useJpMirror() {
  const { data: jpAppointments = [], isLoading: apptsLoading } = useQuery({
    queryKey: ["jp-appointments"],
    queryFn: () => base44.entities.JPAppointment.list("-appointment_date"),
    staleTime: JP_STALE_MS,
  });
  const { data: jpJobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ["jp-jobs"],
    queryFn: () => base44.entities.JPJob.list("-contract_signed_date"),
    staleTime: JP_STALE_MS,
  });
  return { jpAppointments, jpJobs, isLoading: apptsLoading || jobsLoading };
}

function money(v) { return "$" + Math.round(Number(v) || 0).toLocaleString(); }

/**
 * Section divider + provenance note. Every JP block sits under one of these.
 * @param {{ children: React.ReactNode, subtitle?: string }} props
 */
export function JpSectionShell({ children, subtitle }) {
  return (
    <div className="space-y-3 pt-2">
      <div className="border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <Database className="w-4 h-4 text-sky-700" />
          <h2 className="text-lg font-heading font-bold text-primary">From JobProgress (CRM)</h2>
          <span className="text-[10px] font-bold uppercase tracking-wide bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full">CRM source</span>
        </div>
        <p className="text-xs text-muted-foreground mt-1">{subtitle ?? JP_SOURCE_NOTE}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * The debrief counterpart of JpSectionShell's header — placed above the
 * existing debrief-derived cards so every dashboard reads as two explicitly
 * labeled sections: what the reps reported, and what the CRM recorded.
 */
export function DebriefSectionHeader() {
  return (
    <div className="flex items-center gap-2 pt-1">
      <ClipboardList className="w-4 h-4 text-amber-700" />
      <h2 className="text-lg font-heading font-bold text-primary">From Debriefs</h2>
      <span className="text-[10px] font-bold uppercase tracking-wide bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">Rep-submitted</span>
      <span className="text-xs text-muted-foreground">outcomes, amounts and attribution as reps reported them</span>
    </div>
  );
}

function JpEmptyState() {
  return (
    <div className="bg-white rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
      No JobProgress data synced yet. An admin can run a sync or the 2026 backfill
      from the <span className="font-semibold">JobProgress Sync</span> page.
    </div>
  );
}

/**
 * The CRM headline card grid — the JP counterpart of each dashboard's debrief
 * cards. Shared by every dashboard so the two sections always compare the
 * same figures, computed the same way.
 */
export function JpHeadlineCards({ filter, cs, ce, debriefs }) {
  const { jpAppointments, jpJobs, isLoading } = useJpMirror();
  if (isLoading) return null;

  const stats = jpAppointmentStats(jpAppointments, filter, cs, ce);
  const twoLeg = jpTwoLegStats(jpAppointments, filter, cs, ce);
  const revenue = jpRevenueStats(jpJobs, filter, cs, ce);
  const coverage = jpDebriefCoverage(jpAppointments, debriefs || [], filter, cs, ce);

  const cards = [
    { label: "Appointments (CRM)", value: stats.run,
      title: `${JP_APPOINTMENTS_DEFINITION} This period: ${stats.total} on the calendar − ${stats.nonSales} non-sales − ${stats.noShows} no-shows`
        + ` − ${stats.awaitingResult} awaiting result − ${stats.upcoming} upcoming − ${stats.noResult} cancelled / no result = ${stats.run}.` },
    { label: "On Calendar", value: stats.total,
      title: "Every appointment on the JobProgress calendar in this period, of every kind — the gross count before anything is excluded." },
    { label: "Awaiting Result", value: stats.awaitingResult, rating: stats.awaitingResult > 0 ? "yellow" : null,
      title: JP_AWAITING_DEFINITION },
    { label: "Upcoming", value: stats.upcoming,
      title: "Sales appointments dated today or later in this period — nothing to record yet." },
    { label: "No-Shows", value: stats.noShows,
      title: "Sales-type appointments whose CRM result is \"No See\": the rep went, the customer did not." },
    { label: "Cancelled / No Result", value: stats.noResult,
      title: `Sales appointments titled CANCELLED, plus ones held more than ${AWAITING_RESULT_DAYS} days ago whose result was never recorded.` },
    { label: "Non-Sales Visits", value: stats.nonSales,
      title: "Warranty callbacks, walk-throughs, inspections, deliveries — on the calendar but not sales opportunities." },
    { label: "CRM Two-Leg %", value: twoLeg.twoLeg + twoLeg.oneLeg > 0 ? twoLeg.rate + "%" : "—",
      title: `${JP_TWO_LEG_DEFINITION} This period: ${twoLeg.twoLeg} two-leg / ${twoLeg.oneLeg} one-leg, ${twoLeg.answered} of ${twoLeg.eligible} answered.` },
    { label: "Signed Jobs", value: revenue.signedJobs,
      title: "Jobs whose contract was signed in this period, straight from JobProgress." },
    { label: "Signed Revenue", value: money(revenue.revenue),
      title: JP_REVENUE_DEFINITION + (revenue.missingFinancials > 0
        ? ` ${revenue.missingFinancials} signed job(s) have no financial summary yet, so the true figure is higher.` : "") },
    { label: "Avg Job (CRM)", value: revenue.withFinancials > 0 ? money(revenue.avgJob) : "—",
      title: "Signed revenue ÷ signed jobs with financials." },
    { label: "Debrief Coverage", value: coverage.appointments > 0 ? coverage.coverageRate + "%" : "—",
      title: `${JP_COVERAGE_DEFINITION} This period: ${coverage.debriefed} of ${coverage.appointments} run appointments covered, ${coverage.missing} missing.` },
  ];

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {cards.map((c) => <KpiCard key={c.label} label={c.label} value={c.value} title={c.title} rating={c.rating ?? null} />)}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Hover any card for its definition. Revenue here is the contract value recorded in
        JobProgress, attributed to the signed month — the debrief section above uses the
        amount the rep typed in.
      </p>
    </>
  );
}

/** The KPI dashboard's JP section: headline cards + volume + signed revenue. */
export function JpKpiSection({ filter, cs, ce, debriefs }) {
  const { jpAppointments, jpJobs, isLoading } = useJpMirror();
  if (isLoading) return null;
  if (jpAppointments.length === 0 && jpJobs.length === 0) {
    return <JpSectionShell><JpEmptyState /></JpSectionShell>;
  }

  const stats = jpAppointmentStats(jpAppointments, filter, cs, ce);
  const revenue = jpRevenueStats(jpJobs, filter, cs, ce);

  return (
    <JpSectionShell>
      <JpHeadlineCards filter={filter} cs={cs} ce={ce} debriefs={debriefs} />

      <div className="grid lg:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <h3 className="font-heading font-bold text-sm text-primary mb-3">CRM Appointment Volume by Week</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={stats.weekly}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="week" tick={{ fontSize: 10 }} tickFormatter={(v) => v.slice(5)} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="total" name="On calendar" fill="#94a3b8" radius={[4, 4, 0, 0]} />
              <Bar dataKey="run" name="Appointments run" fill="#0369a1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <h3 className="font-heading font-bold text-sm text-primary mb-3">Signed Revenue by Division</h3>
          {revenue.byDivision.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No signed jobs in this period.</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={revenue.byDivision} layout="vertical" margin={{ left: 20 }}>
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v) => "$" + (v / 1000).toFixed(0) + "k"} />
                <YAxis dataKey="division" type="category" width={150} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(v) => money(v)} />
                <Bar dataKey="revenue" fill="#0369a1" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </JpSectionShell>
  );
}

/** Setter dashboard: CRM headline cards + booked volume per CRM `created_by`. */
export function JpSetterSection({ filter, cs, ce, debriefs }) {
  const { jpAppointments, isLoading } = useJpMirror();
  if (isLoading) return null;
  if (jpAppointments.length === 0) {
    return <JpSectionShell><JpEmptyState /></JpSectionShell>;
  }
  const rows = jpSetterStats(jpAppointments, filter, cs, ce);

  return (
    <JpSectionShell subtitle={
      "Booked volume as JobProgress recorded it — attributed to whoever created the appointment in the CRM, "
      + "which may differ from the setter chosen on a debrief. Names come from the CRM and are not normalized."
    }>
      <JpHeadlineCards filter={filter} cs={cs} ce={ce} debriefs={debriefs} />
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Booked By (CRM)</th>
              <th className="px-3 py-2" title="On the calendar, of every kind">Booked</th>
              <th className="px-3 py-2" title={JP_APPOINTMENTS_DEFINITION}>Appointments Run</th>
              <th className="px-3 py-2">Result Forms</th>
              <th className="px-3 py-2">Form Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-border/50">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2">{r.total}</td>
                <td className="px-3 py-2 font-semibold">{r.run}</td>
                <td className="px-3 py-2">{r.withResult}</td>
                <td className={`px-3 py-2 font-semibold ${r.salesType === 0 ? "text-muted-foreground" : r.resultCoverageRate >= 80 ? "text-green-700" : r.resultCoverageRate >= 50 ? "text-amber-700" : "text-red-700"}`}>
                  {r.salesType > 0 ? r.resultCoverageRate + "%" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </JpSectionShell>
  );
}

/** Sales-rep dashboard: CRM headline cards + assigned volume per CRM user. */
export function JpRepSection({ filter, cs, ce, debriefs }) {
  const { jpAppointments, isLoading } = useJpMirror();
  if (isLoading) return null;
  if (jpAppointments.length === 0) {
    return <JpSectionShell><JpEmptyState /></JpSectionShell>;
  }
  const rows = jpRepStats(jpAppointments, filter, cs, ce);

  return (
    <JpSectionShell subtitle={
      "Appointment volume as assigned in JobProgress, with the Two-Leg answers reps recorded on the CRM's "
      + "result forms. Coverage is partial — an unanswered form says nothing either way."
    }>
      <JpHeadlineCards filter={filter} cs={cs} ce={ce} debriefs={debriefs} />
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground border-b border-border">
              <th className="px-3 py-2">Rep (CRM)</th>
              <th className="px-3 py-2" title="Assigned on the calendar, of every kind">Assigned</th>
              <th className="px-3 py-2" title={JP_APPOINTMENTS_DEFINITION}>Appointments Run</th>
              <th className="px-3 py-2">Two-Leg</th>
              <th className="px-3 py-2">One-Leg</th>
              <th className="px-3 py-2">CRM Two-Leg %</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-border/50">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2">{r.total}</td>
                <td className="px-3 py-2 font-semibold">{r.run}</td>
                <td className="px-3 py-2">{r.twoLeg}</td>
                <td className="px-3 py-2">{r.oneLeg}</td>
                <td className={`px-3 py-2 font-semibold ${r.twoLeg + r.oneLeg === 0 ? "text-muted-foreground" : r.twoLegRate >= 90 ? "text-green-700" : r.twoLegRate >= 80 ? "text-amber-700" : "text-red-700"}`}>
                  {r.twoLeg + r.oneLeg > 0 ? r.twoLegRate + "%" : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </JpSectionShell>
  );
}
