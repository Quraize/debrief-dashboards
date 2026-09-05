/**
 * The Call Center dashboard's "From JobProgress (CRM)" section: every setter
 * metric the debrief section shows, computed from who created each
 * appointment in JobProgress and how it turned out — plus leads assigned per
 * caller from the customer record, which the debrief form never captures.
 */
import KpiCard from "@/components/KpiCard";
import { JpSectionShell, useJpMirror, useJpCustomers } from "@/components/JpCrmSection";
import { jpCallCenterStats, JP_CALL_CENTER_DEFINITIONS as D } from "@allied/shared/jpCallCenter";

function money(v) { return "$" + Math.round(Number(v) || 0).toLocaleString(); }
const pctOr = (d, v) => (d > 0 ? v + "%" : "—");
const RATING = { Excellent: "text-green-700 bg-green-50", Good: "text-amber-700 bg-amber-50", Poor: "text-red-700 bg-red-50", "No Data": "text-muted-foreground" };

export default function JpCallCenterSection({ filter, cs, ce }) {
  const { jpAppointments, jpJobs, isLoading } = useJpMirror();
  const { customers, isLoading: customersLoading } = useJpCustomers();
  if (isLoading || customersLoading) return null;
  if (jpAppointments.length === 0) {
    return (
      <JpSectionShell>
        <div className="bg-white rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No JobProgress data synced yet. An admin can run a sync from the <span className="font-semibold">JobProgress Sync</span> page.
        </div>
      </JpSectionShell>
    );
  }

  const s = jpCallCenterStats(jpAppointments, customers, jpJobs, filter, cs, ce);
  const cards = [
    { label: "Leads Assigned", value: s.hasLeadData ? s.leadsAssigned : "—", title: D.leadsAssigned + (s.hasLeadData ? "" : " (customer sync has not run yet)") },
    { label: "Appointments Set", value: s.set, accent: true, title: D.set },
    { label: "Set Rate", value: s.hasLeadData ? pctOr(s.leadsAssigned, s.setRate) : "—", title: D.setRate },
    { label: "Booked This Period", value: s.bookedThisPeriod, title: D.bookedThisPeriod },
    { label: "Show Rate", value: pctOr(s.run + s.noSee, s.showRate), title: D.showRate },
    { label: "No See", value: s.noSee, title: D.noSee },
    { label: "Demos", value: s.demos, title: D.demos },
    { label: "Demo %", value: pctOr(s.run, s.demoRate), title: D.demoRate },
    { label: "Two-Leg %", value: pctOr(s.twoLegEligible, s.twoLegRate), rating: s.twoLegRating === "Excellent" ? "green" : s.twoLegRating === "Good" ? "yellow" : s.twoLegRating === "Poor" ? "red" : null,
      title: `${D.twoLegRate} This period: ${s.twoLeg} two-leg of ${s.twoLegEligible} run (${s.oneLeg} one-leg, ${s.twoLegEligible - s.twoLeg - s.oneLeg} unanswered).` },
    { label: "Sales", value: s.sales, title: D.sales },
    { label: "Sales $ (CRM)", value: money(s.salesAmount), title: D.salesAmount + (s.salesMissingAmount ? ` ${s.salesMissingAmount} sale(s) have no contract value in the CRM yet.` : "") },
    { label: "SER", value: s.demos > 0 ? s.ser : "—", rating: s.serRating === "Excellent" ? "green" : s.serRating === "Good" ? "yellow" : s.serRating === "Poor" ? "red" : null, title: D.ser },
    { label: "Resets", value: s.resets, title: D.resets },
    { label: "Awaiting / Cancelled", value: s.pending, title: D.pending },
    ...(s.hasLeadData ? [{ label: "Leads w/o Call Center Rep", value: s.leadsUnassigned, rating: s.leadsUnassigned > 0 ? "yellow" : null, title: D.leadsUnassigned }] : []),
  ];

  return (
    <JpSectionShell subtitle={
      "Setter performance as JobProgress recorded it: appointments by whoever created them in the CRM, outcomes from the result forms, "
      + "leads from the customer's Call Center Rep field. Outcomes are by appointment date, like the debrief section above."
    }>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {cards.map((c) => <KpiCard key={c.label} label={c.label} value={c.value} title={c.title} accent={c.accent} rating={c.rating ?? null} />)}
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="p-3 border-b border-border/60">
          <h3 className="font-heading font-bold text-sm text-primary">Setters (CRM)</h3>
          <p className="text-xs text-muted-foreground">One row per person who created appointments in JobProgress. Reps booking their own appointments are collapsed into one row. Hover a column header for its definition.</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-max">
            <thead>
              <tr className="border-b border-border bg-secondary/50 text-left text-muted-foreground">
                <th className="px-2.5 py-2 font-semibold whitespace-nowrap">Setter</th>
                {COLS.map(([key, label, def]) => <th key={key} title={def} className="px-2.5 py-2 font-semibold whitespace-nowrap text-center cursor-help">{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {s.bySetter.map((r) => (
                <tr key={r.label} className={`border-b border-border/50 ${r.isReps ? "text-muted-foreground italic" : ""}`}>
                  <td className="px-2.5 py-2 font-medium whitespace-nowrap">{r.label}</td>
                  {COLS.map(([key, , , kind]) => <td key={key} className={`px-2.5 py-2 text-center ${cellClass(r, key, kind)}`}>{cell(r, key, kind, s.hasLeadData)}</td>)}
                </tr>
              ))}
              <tr className="bg-secondary/40 font-bold">
                <td className="px-2.5 py-2">Team</td>
                {COLS.map(([key, , , kind]) => <td key={key} className="px-2.5 py-2 text-center">{cell(s, key, kind, s.hasLeadData)}</td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </JpSectionShell>
  );
}

const COLS = [
  ["leadsAssigned", "Leads", D.leadsAssigned, "leads"], ["set", "Set", D.set], ["setRate", "Set %", D.setRate, "rate:leads"],
  ["run", "Run", D.run], ["noSee", "No See", D.noSee], ["showRate", "Show %", D.showRate, "rate:shows"],
  ["demos", "Demos", D.demos], ["demoRate", "Demo %", D.demoRate, "rate:run"],
  ["twoLegRate", "2-Leg %", D.twoLegRate, "rate:twoleg"], ["sales", "Sales", D.sales],
  ["salesAmount", "Sales $", D.salesAmount, "money"], ["ser", "SER", D.ser, "ser"], ["resets", "Resets", D.resets], ["pending", "Pending", D.pending],
];
const DENOM = { "rate:leads": (r) => r.leadsAssigned, "rate:shows": (r) => r.run + r.noSee, "rate:run": (r) => r.run, "rate:twoleg": (r) => r.twoLegEligible };

function cell(r, key, kind, hasLeadData) {
  if (kind === "leads") return hasLeadData ? (r[key] || "") : "—";
  if (kind === "rate:leads" && !hasLeadData) return "—";
  if (kind?.startsWith("rate:")) return DENOM[kind](r) > 0 ? r[key] + "%" : "—";
  if (kind === "money") return r[key] ? money(r[key]) : "—";
  if (kind === "ser") return r.demos > 0 ? r[key] : "—";
  return r[key] || "";
}
function cellClass(r, key, kind) {
  if (kind === "ser" && r.demos > 0) return `font-bold ${RATING[r.serRating]}`;
  if (kind === "rate:twoleg" && r.twoLegEligible > 0) return `font-bold ${RATING[r.twoLegRating]}`;
  return "";
}
