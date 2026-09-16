import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowDown } from "lucide-react";
import { get, qs } from "@/api/http";

const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

/**
 * The header row: leads in the range (JobProgress jobs created in it), how
 * many got an appointment, and why the rest did not — by the office's own
 * stage names. Sits above the appointment funnel rather than feeding it:
 * leads are counted by created date and appointments by appointment date, so
 * the two never add up exactly across a month boundary, and pretending they
 * do would be the one dishonest arrow on the page.
 */
function LeadsHeader({ from, to }) {
  const enabled = !!from && !!to;
  const { data, isLoading, error } = useQuery({
    queryKey: ["leads-flow", from, to],
    queryFn: () => get(`/api/leads/flow${qs({ from, to })}`),
    enabled, staleTime: 60_000,
  });
  if (!enabled) return null;
  if (isLoading) return <div className="text-xs text-muted-foreground mb-3">Loading leads…</div>;
  if (error || !data) return <div className="text-xs text-muted-foreground mb-3">Leads unavailable right now.</div>;
  const reasons = data.reasons.filter((r) => r.count > 0);
  return (
    <div className="mb-3 pb-3 border-b border-border">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_1fr] gap-3 lg:gap-2 items-start">
        <Box tone="navy" label="Leads" value={data.leads}
          note="Jobs created in JobProgress in this range, insurance excluded" />
        <Connector />
        <Box tone="green" label="Appointment Set" value={data.set} share={data.setRate} of="of leads"
          note="A sales appointment exists for the lead" />
        <div className="flex flex-col gap-1.5">
          <Box tone="amber" label="Not Set" value={data.notSet} share={data.notSetRate} of="of leads" />
          {reasons.length > 0 && (
            <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs">
              {reasons.map((r) => (
                <div key={r.key} className="flex items-baseline justify-between gap-2 py-0.5">
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="font-semibold tabular-nums">{r.count} <span className="text-muted-foreground font-normal">{r.share}%</span></span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The executive's funnel: Set → Ran / No See → Demo / No Demo → Sold / No sale.
 * Four columns that read left to right on a desktop and top to bottom on a
 * phone; every column sums to the box that feeds it, and each box says what
 * share of its parent it is. Numbers come from appointmentFlow() in shared
 * so they are the same numbers the Marketing dashboard shows.
 *
 * @param {{ flow: ReturnType<import("@allied/shared/kpi").appointmentFlow>, rangeLabel: string, resultsHref?: string }} props
 */
export default function AppointmentFlow({ flow, rangeLabel, resultsHref = "/results", from, to }) {
  const f = flow;
  if (!f || f.set === 0) {
    return (
      <Panel rangeLabel={rangeLabel} resultsHref={resultsHref}>
        <LeadsHeader from={from} to={to} />
        <p className="text-sm text-muted-foreground py-6 text-center">No appointments set in this period.</p>
      </Panel>
    );
  }
  return (
    <Panel rangeLabel={rangeLabel} resultsHref={resultsHref}>
      <LeadsHeader from={from} to={to} />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] gap-3 lg:gap-2 items-start">
        <Column>
          <Box tone="navy" label="Set Appointments" value={f.set}
            note="Booked and resolved: ran, or a No See" />
        </Column>
        <Connector />
        <Column>
          <Box tone="green" label="Ran" value={f.ran} share={f.ranRate} of="of set" />
          <Box tone="red" label="No See" value={f.noSee} share={f.noSeeRate} of="of set"
            note="No show, or cancelled before the visit" />
        </Column>
        <Connector />
        <Column>
          <Box tone="green" label="Demo" value={f.demo} share={f.demoRate} of="of ran" />
          <Box tone="amber" label="No Demo" value={f.noDemo} share={f.noDemoRate} of="of ran" />
          {f.pending > 0 && (
            <Box tone="slate" label="Result Pending" value={f.pending} share={f.pendingRate} of="of ran"
              note="Ran; outcome not yet settled (estimate in progress)" />
          )}
        </Column>
        <Connector />
        <Column>
          <Box tone="gold" label="Sold" value={f.sold} share={f.soldRate} of="of demos" sub={money(f.revenue)}
            note="Demos in this range that have sold to date, later phone or email closes included" />
          <Box tone="slate" label="No Sale" value={f.notSold} share={f.notSoldRate} of="of demos" />
        </Column>
      </div>
    </Panel>
  );
}

function Panel({ rangeLabel, resultsHref, children }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2 className="font-heading font-bold text-primary">Appointment Flow</h2>
          <p className="text-xs text-muted-foreground">{rangeLabel} · leads from JobProgress by created date; appointments from filed debriefs by appointment date. Insurance excluded throughout.</p>
        </div>
        <Link to={resultsHref} className="text-xs font-semibold text-accent hover:underline">Open Results Review →</Link>
      </div>
      {children}
    </div>
  );
}

function Column({ children }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

function Connector() {
  return (
    <div className="flex lg:flex-col items-center justify-center text-muted-foreground/60 lg:pt-6">
      <ArrowDown className="w-5 h-5 lg:hidden" />
      <ArrowRight className="w-5 h-5 hidden lg:block" />
    </div>
  );
}

// Tones carry meaning, not decoration: navy is the whole, green is progress,
// red is lost, amber is attention, gold is money, slate is "nothing more here".
const TONES = {
  navy: "bg-primary text-primary-foreground border-primary",
  green: "bg-green-50 text-green-900 border-green-200",
  red: "bg-red-50 text-red-900 border-red-200",
  amber: "bg-amber-50 text-amber-900 border-amber-200",
  gold: "bg-accent/10 text-primary border-accent/40 ring-1 ring-accent/30",
  slate: "bg-secondary/60 text-foreground border-border",
};

function Box({ tone, label, value, share, of, sub, note }) {
  const dark = tone === "navy";
  return (
    <div className={`rounded-xl border p-3 ${TONES[tone]}`} title={note || undefined}>
      <div className={`text-[11px] uppercase tracking-wide font-semibold ${dark ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-2xl font-heading font-bold tabular-nums">{value}</span>
        {share != null && of && (
          <span className={`text-xs font-semibold ${dark ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{share}% <span className="font-normal">{of}</span></span>
        )}
      </div>
      {sub && <div className="text-sm font-semibold mt-0.5">{sub}</div>}
      {note && <div className={`text-[11px] mt-1 leading-snug ${dark ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{note}</div>}
    </div>
  );
}
