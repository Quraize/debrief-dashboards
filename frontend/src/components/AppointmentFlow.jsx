import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowDown, Loader2 } from "lucide-react";
import { get, qs } from "@/api/http";

const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

/**
 * The executive's funnel, followed lead by lead:
 *
 *   Leads → Appointment Set / Not Set (why) → Ran / No See / Awaiting
 *         → Demo / No Demo / Pending → Sold / No Sale
 *
 * Every box is a count of LEADS created in the range, so each column sums to
 * the box that feeds it and a lead is counted once however many visits it
 * took. Five columns that read left to right on a desktop and top to bottom
 * on a phone. Numbers come from GET /api/leads/flow (shared/src/leadFlow.js).
 *
 * This is a different question from the Marketing and Sales dashboards, which
 * count appointments by appointment date — and the subtitle says so.
 *
 * @param {{ from: string, to: string, rangeLabel: string, resultsHref?: string }} props
 */
export default function AppointmentFlow({ from, to, rangeLabel, resultsHref = "/results" }) {
  const enabled = !!from && !!to;
  const { data: f, isLoading, error } = useQuery({
    queryKey: ["leads-flow", from, to],
    queryFn: () => get(`/api/leads/flow${qs({ from, to })}`),
    enabled, staleTime: 60_000,
  });

  let body;
  if (!enabled) body = <Empty>Pick a date range to see the flow.</Empty>;
  else if (isLoading) body = <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  else if (error || !f) body = <Empty>The flow could not be loaded right now.</Empty>;
  else if (f.leads === 0) body = <Empty>No leads came in during this period.</Empty>;
  else body = <Funnel f={f} />;

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2 className="font-heading font-bold text-primary">Lead Flow</h2>
          <p className="text-xs text-muted-foreground max-w-3xl">
            {rangeLabel} · every lead that came in during this period, followed through whatever happened to it — even if the
            appointment fell in a later month. Leads are JobProgress jobs by created date; results come from filed debriefs.
            Insurance and warranty callbacks excluded. The Marketing and Sales dashboards count appointments by appointment date,
            so their Set Appointments will differ — a different question, not a discrepancy.
          </p>
        </div>
        <Link to={resultsHref} className="text-xs font-semibold text-accent hover:underline shrink-0">Open Results Review →</Link>
      </div>
      {body}
    </div>
  );
}

function Funnel({ f }) {
  const reasons = f.reasons.filter((r) => r.count > 0);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] gap-3 lg:gap-2 items-start">
      <Column>
        <Box tone="navy" label="Leads" value={f.leads} note="Jobs created in JobProgress in this range" />
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Appointment Set" value={f.set} share={f.setRate} of="of leads"
          note="A sales appointment exists for the lead" />
        <Box tone="amber" label="Not Set" value={f.notSet} share={f.notSetRate} of="of leads" />
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
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Ran" value={f.ran} share={f.ranRate} of="of set" note="The rep attended at least one visit" />
        <Box tone="red" label="No See" value={f.noSee} share={f.noSeeRate} of="of set" note="Every visit so far was a no-show or cancelled" />
        {f.awaiting > 0 && (
          <Box tone="slate" label="Awaiting" value={f.awaiting} share={f.awaitingRate} of="of set"
            note="Booked but not yet run, or run and not yet debriefed" />
        )}
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
          note="Leads that have sold to date, later phone or email closes included" />
        <Box tone="slate" label="No Sale" value={f.notSold} share={f.notSoldRate} of="of demos" />
      </Column>
    </div>
  );
}

function Empty({ children }) {
  return <p className="text-sm text-muted-foreground py-6 text-center">{children}</p>;
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
// red is lost, amber is attention, gold is money, slate is "nothing more yet".
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
