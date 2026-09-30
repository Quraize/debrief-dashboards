/**
 * The top of the funnel, the PM's way (2026-09-30): Raw Leads, Valid Leads,
 * Appointments Set and Appointment Set Rate = Appointments Set ÷ Valid Leads,
 * plus lead quality (valid share and why leads were disqualified or never
 * set). Read from GET /api/leads/flow on the COHORT basis — every lead that
 * came in during the period, followed through — because that is the only
 * basis on which "set ÷ valid" is an honest rate. Each card opens its rows.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Info } from "lucide-react";
import { get, qs } from "@/api/http";

const DEF = {
  leads: "Raw Leads = every job created in JobProgress in this period (by created date). Insurance and warranty callbacks excluded.",
  valid: "Valid Leads = Raw Leads minus the leads moved to a disqualified stage. Every rate to the right is measured against this number.",
  set: "Appointments Set = valid leads from this period that have a sales appointment (a lead counts once, however many visits it took).",
  setRate: "Appointment Set Rate = Appointments Set ÷ Valid Leads, for the leads that came in during this period.",
};

export default function TopOfFunnel({ from, to }) {
  const enabled = !!from && !!to;
  const { data: f, isLoading, error } = useQuery({
    queryKey: ["leads-flow", from, to, "cohort"],
    queryFn: () => get(`/api/leads/flow${qs({ from, to, basis: "cohort" })}`),
    enabled, staleTime: 60_000,
  });
  const href = (card, label) => `/lead-flow${qs({ from, to, basis: "cohort", card, label })}`;
  const pct = (v) => (v == null ? "—" : `${v}%`);

  return (
    <section className="bg-white rounded-xl border border-border p-4 shadow-sm" aria-labelledby="funnel-h">
      <div className="flex items-baseline gap-2 mb-2">
        <h2 id="funnel-h" className="text-xs font-bold uppercase tracking-wide text-primary">Top of the funnel</h2>
        <span className="text-[11px] text-muted-foreground">· leads that came in during this period, followed through · each card shows its definition on hover</span>
      </div>
      {!enabled ? <p className="text-sm text-muted-foreground">Pick a date range to see the funnel.</p>
        : isLoading ? <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        : error || !f ? <p className="text-sm text-muted-foreground">The funnel could not be loaded right now.</p>
        : (
          <>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card to={href("leads", "Leads")} label="Raw Leads" value={f.leads} hint={DEF.leads} />
              <Card to={href("valid", "Valid Leads")} label="Valid Leads" value={f.valid} sub={`${pct(f.validRate)} of raw · ${f.disqualified} disqualified`} hint={DEF.valid} />
              <Card to={href("set", "Appointment Set")} label="Appointments Set" value={f.set} sub={`${f.notSet} valid leads not set yet`} hint={DEF.set} />
              <Card to={href("set", "Appointment Set")} label="Appointment Set Rate" value={pct(f.setRate)} sub={`${f.set} set ÷ ${f.valid} valid`} hint={DEF.setRate} accent />
            </div>
            <LeadQuality f={f} href={href} />
          </>
        )}
    </section>
  );
}

/** Lead quality: how much of what came in was worth calling, and why the rest was not set. */
function LeadQuality({ f, href }) {
  const reasons = (f.reasons ?? []).filter((r) => r.count > 0);
  return (
    <div className="mt-3 rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs">
      <span className="font-semibold text-primary">Lead quality:</span>{" "}
      <Link to={href("valid", "Valid Leads")} className="hover:text-accent">{f.validRate ?? 0}% of raw leads were valid</Link>
      {" · "}
      <Link to={href("disqualified", "Disqualified")} className="hover:text-accent">{f.disqualifiedRate ?? 0}% disqualified</Link>
      {reasons.length > 0 && (
        <>
          {" · not set because: "}
          {reasons.map((r, i) => (
            <span key={r.key}>
              {i > 0 && ", "}
              <Link to={href(`reason:${r.key}`, `Not Set — ${r.label}`)} className="hover:text-accent">{r.label} {r.count} ({r.share}%)</Link>
            </span>
          ))}
        </>
      )}
    </div>
  );
}

function Card({ to, label, value, sub, hint, accent }) {
  return (
    <Link to={to} title={hint} className={`block rounded-xl border border-border bg-white p-4 shadow-sm hover:shadow-md ${accent ? "ring-2 ring-accent/40" : ""}`}>
      <span className="flex items-start gap-1 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold leading-tight">
        <span>{label}</span><Info className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      </span>
      <span className="block text-2xl font-heading font-bold mt-1 text-primary tabular-nums">{value}</span>
      {sub && <span className="block text-[11px] text-muted-foreground mt-0.5">{sub}</span>}
    </Link>
  );
}
