import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, ArrowDown, Loader2 } from "lucide-react";
import { get, qs } from "@/api/http";

const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

/**
 * The executive's funnel:
 *
 *   Leads → Valid Leads / Disqualified → Appointment Set / Not Set (why)
 *         → Ran / No See / Awaiting → Demo / No Demo / Pending → Sold / No Sale
 *
 * Valid = leads − disqualified (the CEO's definition). A lead is counted once
 * however many visits it took. Six columns that read left to right on a wide
 * screen and top to bottom below that. Numbers come from GET /api/leads/flow
 * (shared/src/leadFlow.js), which answers either of two questions:
 *
 *   Work done in the range (the default) — everything from Appointment Set
 *     rightward counts visits that fall in the range, whenever the lead came
 *     in. This is what "how many did we run this month" means, and it matches
 *     the Marketing and Sales dashboards' basis.
 *   Leads that came in — the same leads followed wherever their appointments
 *     went, even into a later month. Judges lead quality, and always reads low
 *     early in a month because new leads have not had time to convert.
 *
 * The lead columns are identical in both: a lead arrives once.
 *
 * @param {{ from: string, to: string, rangeLabel: string, resultsHref?: string }} props
 */
const BASES = [
  { key: "activity", label: "Work done in this range" },
  { key: "cohort", label: "Leads that came in" },
];

export default function AppointmentFlow({ from, to, rangeLabel, resultsHref = "/results" }) {
  const [basis, setBasis] = useState("activity");
  const enabled = !!from && !!to;
  const { data: f, isLoading, error } = useQuery({
    queryKey: ["leads-flow", from, to, basis],
    queryFn: () => get(`/api/leads/flow${qs({ from, to, basis })}`),
    enabled, staleTime: 60_000,
  });
  const activity = basis === "activity";

  let body;
  if (!enabled) body = <Empty>Pick a date range to see the flow.</Empty>;
  else if (isLoading) body = <div className="flex justify-center py-8"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  else if (error || !f) body = <Empty>The flow could not be loaded right now.</Empty>;
  else if (f.leads === 0 && f.set === 0) body = <Empty>Nothing happened in this period, and no leads came in.</Empty>;
  else body = <Funnel f={f} activity={activity} from={from} to={to} basis={basis} />;

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="font-heading font-bold text-primary">Lead Flow</h2>
          <p className="text-xs text-muted-foreground max-w-3xl">
            {rangeLabel} · {activity
              ? "the visits that fall in this period and what came of them, whenever the lead first came in. Appointment Set rightward counts visits, the same basis as the Sales and Marketing dashboards, so a lead seen twice is two visits. Leads, Valid and Not Set still describe the leads that arrived in the period — a lead arrives once."
              : "every lead that came in during this period, followed through whatever happened to it, even if the appointment fell in a later month. A lead is counted once however many visits it took, and early in a month this reads low: those leads have not had time to convert."}
            {" "}Leads are JobProgress jobs by created date; results come from filed debriefs. Insurance and warranty callbacks excluded.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <div className="flex rounded-lg border border-border overflow-hidden" role="group" aria-label="What the flow counts">
            {BASES.map((b) => (
              <button key={b.key} onClick={() => setBasis(b.key)} aria-pressed={basis === b.key}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${
                  basis === b.key ? "bg-accent text-white" : "bg-white text-muted-foreground hover:bg-secondary"
                }`}>
                {b.label}
              </button>
            ))}
          </div>
          <Link to={resultsHref} className="text-xs font-semibold text-accent hover:underline">Open Results Review →</Link>
        </div>
      </div>
      {body}
    </div>
  );
}

function Funnel({ f, activity, from, to, basis }) {
  const reasons = f.reasons.filter((r) => r.count > 0);
  const byVisit = !!f.byVisit;
  const unit = byVisit ? "visits" : "leads";
  // Every card opens the rows behind its number. Range, basis and card travel
  // in the URL so a manager can send the link straight to whoever owns them.
  const href = (card, label) => `/lead-flow${qs({ from, to, basis, card, label })}`;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr_auto_1fr] gap-3 xl:gap-2 items-start">
      <Column>
        <Box tone="navy" label="Leads" value={f.leads} note="Jobs created in JobProgress in this range" to={href("leads", "Leads")} />
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Valid Leads" value={f.valid} share={f.validRate} of="of leads" to={href("valid", "Valid Leads")}
          note="Leads minus disqualified. Everything to the right is measured against this number." />
        <Box tone="red" label="Disqualified" value={f.disqualified} share={f.disqualifiedRate} of="of leads" to={href("disqualified", "Disqualified")}
          note="Moved to a DQ stage in JobProgress by the call center or a manager" />
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Appointment Set" value={f.set} share={f.setRate} of="of valid" to={href("set", "Appointment Set")}
          note={activity
            ? `Visits booked in this period, resets counted separately — the same basis as the Sales and Marketing dashboards.${f.setFromEarlier ? ` ${f.setFromEarlier} belong to leads that came in before this period.` : ""}`
            : "A sales appointment exists for the lead"} />
        <Box tone="amber" label="Not Set" value={f.notSet} share={f.notSetRate} of="of valid" to={href("notSet", "Not Set")}
          note={activity ? "Valid leads from this period with no appointment booked yet" : undefined} />
        {reasons.length > 0 && (
          <div className="rounded-xl border border-border bg-secondary/40 px-3 py-2 text-xs">
            {reasons.map((r) => (
              <Link key={r.key} to={href(`reason:${r.key}`, `Not Set — ${r.label}`)}
                className="flex items-baseline justify-between gap-2 py-0.5 hover:text-accent">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-semibold tabular-nums">{r.count} <span className="text-muted-foreground font-normal">{r.share}%</span></span>
              </Link>
            ))}
          </div>
        )}
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Ran" value={f.ran} share={f.ranRate} of="of set" to={href("ran", "Ran")}
          note={byVisit ? "Visits the rep attended" : "The rep attended at least one visit"} />
        <Box tone="red" label="No See" value={f.noSee} share={f.noSeeRate} of="of set" to={href("noSee", "No See")}
          note={byVisit ? "Visits that were a no-show or cancelled" : "Every visit so far was a no-show or cancelled"} />
        {f.awaiting > 0 && (
          <Box tone="slate" label="Awaiting" value={f.awaiting} share={f.awaitingRate} of="of set" to={href("awaiting", "Awaiting")}
            note={`Booked but not yet run, or run and not yet debriefed (${unit})`} />
        )}
      </Column>
      <Connector />
      <Column>
        <Box tone="green" label="Demo" value={f.demo} share={f.demoRate} of="of ran" to={href("demo", "Demo")}
          note={byVisit ? "Visits that gave a demo — the Sales dashboard's Demos" : undefined} />
        <Box tone="amber" label="No Demo" value={f.noDemo} share={f.noDemoRate} of="of ran" to={href("noDemo", "No Demo")} />
        {f.pending > 0 && (
          <Box tone="slate" label="Result Pending" value={f.pending} share={f.pendingRate} of="of ran" to={href("pending", "Result Pending")}
            note="Ran; outcome not yet settled (estimate in progress)" />
        )}
      </Column>
      <Connector />
      <Column>
        <Box tone="gold" label="Sold" value={f.sold} share={f.soldRate} of="of demos" sub={money(f.revenue)} to={href("sold", "Sold")}
          note={byVisit
            ? `Sales signed in this period — the Sales dashboard's Sales and Revenue exactly. A demo from an earlier month closed now counts here, so this can exceed the sales made by the ${f.demo} demos above (${f.demoSold} of those have sold).`
            : "Leads that have sold to date, later phone or email closes included"} />
        <Box tone="slate" label="No Sale" value={f.notSold} share={f.notSoldRate} of="of demos" to={href("notSold", "No Sale")} />
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

// The arrows are the flow. Indigo is deliberately a colour no card uses —
// not the navy, green, red, amber, gold or grey of the boxes — so the eye
// reads "step" and never "part of that card". Heavier stroke than an icon.
function Connector() {
  return (
    <div className="flex xl:flex-col items-center justify-center text-indigo-600 xl:pt-7" aria-hidden="true">
      <ArrowDown className="w-7 h-7 xl:hidden" strokeWidth={2.75} />
      <ArrowRight className="w-7 h-7 hidden xl:block" strokeWidth={2.75} />
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

function Box({ tone, label, value, share, of, sub, note, to }) {
  const dark = tone === "navy";
  const Tag = to ? Link : "div";
  const props = to ? { to, title: note ? `${note} — click for the list` : "Click for the list" } : { title: note || undefined };
  return (
    <Tag {...props} className={`block rounded-xl border p-3 ${TONES[tone]} ${to ? "transition-shadow hover:shadow-md hover:ring-2 hover:ring-accent/40 cursor-pointer" : ""}`}>
      <div className={`text-[11px] uppercase tracking-wide font-semibold ${dark ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{label}</div>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-2xl font-heading font-bold tabular-nums">{value}</span>
        {share != null && of && (
          <span className={`text-xs font-semibold ${dark ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{share}% <span className="font-normal">{of}</span></span>
        )}
      </div>
      {sub && <div className="text-sm font-semibold mt-0.5">{sub}</div>}
      {note && <div className={`text-[11px] mt-1 leading-snug ${dark ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{note}</div>}
    </Tag>
  );
}
