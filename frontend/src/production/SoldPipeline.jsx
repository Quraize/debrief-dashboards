/**
 * Sold-Job Pipeline / Unscheduled Work — the production dashboard's #1 view.
 *
 * Headline totals on top, the detail underneath: every sold job that has not
 * yet been paid for, what it is worth, whether it is on the calendar, and —
 * for the ones that are not — what is blocking it, who owns it and what
 * happens next. Blocker is read off the JobProgress stage until production
 * types its own; Owner and Next Action are always production's.
 *
 * Rules and totals come from shared/src/soldPipeline.js via
 * GET /api/production/pipeline. Nothing ages off: the list is oldest sale
 * first so the stale jobs sit where they have to be seen.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { PIPELINE_ROLES } from "@allied/shared/constants";
import { BUCKETS, pipelineTotals } from "@allied/shared/soldPipeline";
import { QUEUE_DATE_FILTERS, ALL_TIME_FILTER, inDateRange } from "@allied/shared/constants";
import DateRangeFilter from "@/components/DateRangeFilter";
import ScrollTable from "@/components/ScrollTable";
import { Loader2, ExternalLink, Search, Pencil, Check, Sparkles, ChevronDown, ChevronUp } from "lucide-react";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" }) : "—");
const fmtWeek = (s) => (s ? "Wk of " + new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : "—");

const TONE = {
  red: "bg-red-50 text-red-900 border-red-200",
  green: "bg-green-50 text-green-900 border-green-200",
  blue: "bg-blue-50 text-blue-900 border-blue-200",
  amber: "bg-amber-50 text-amber-900 border-amber-200",
  navy: "bg-primary text-primary-foreground border-primary",
  slate: "bg-white text-primary border-border",
};

export default function SoldPipeline() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  // Management only: admin, sales manager, project manager. Everyone allowed here may edit the instructions.
  const allowed = !!me && PIPELINE_ROLES.includes(me.role);
  const isManager = allowed;
  const { data, isLoading, error } = useQuery({ queryKey: ["production-pipeline"], queryFn: productionApi.pipeline, enabled: allowed, staleTime: 60_000 });
  const [bucket, setBucket] = useState("unscheduled");
  const [q, setQ] = useState("");
  const [noValueOnly, setNoValueOnly] = useState(false);
  // The range chips every dashboard has, applied to the date you choose: when
  // the job was SOLD, or when its install STARTS. A pipeline is a snapshot, so
  // the default is everything.
  const [range, setRange] = useState(ALL_TIME_FILTER);
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [basis, setBasis] = useState("sold");

  // Rows inside the date range, whatever bucket is picked — the cards add these up.
  const inRange = useMemo(() => {
    const all = data?.rows ?? [];
    if (range === ALL_TIME_FILTER) return all;
    return all.filter((r) => inDateRange(basis === "sold" ? r.contractSignedDate : r.scheduledDate, range, cs, ce));
  }, [data, range, cs, ce, basis]);
  const t = useMemo(() => (data ? pipelineTotals(inRange, data.today) : null), [inRange, data]);

  const rows = useMemo(() => {
    let list = inRange;
    if (bucket !== "all") list = list.filter((r) => r.bucket === bucket);
    if (noValueOnly) list = list.filter((r) => r.noContractValue);
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((r) => [r.customer, r.jobNumber, r.city, r.address, r.stage, r.rep, r.owner, r.blocker, r.nextAction].some((v) => String(v ?? "").toLowerCase().includes(s)));
    return list;
  }, [inRange, bucket, q, noValueOnly]);

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">The Sold Pipeline is for managers: admin, sales manager or project manager.</div>;
  const filtered = range !== ALL_TIME_FILTER;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Sold-Job Pipeline</h1>
        <p className="text-sm text-muted-foreground max-w-4xl">
          Every job with a signed contract that has not yet been paid for, from JobProgress. <strong>Scheduled</strong> means an install visit is
          on the calendar or the stage says so; <strong>Unscheduled</strong> is sold work with no production date. A multi-day install counts
          in the week it starts. Blocker is read from the JobProgress stage until you type your own; Owner and Next Action are yours.
          Oldest sale first — nothing drops off.
        </p>
      </div>

      <div className="flex flex-col lg:flex-row lg:items-start gap-3">
        <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
          filters={QUEUE_DATE_FILTERS} className="flex-1" />
        <div className="bg-white rounded-xl border border-border p-3 shadow-sm">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">Range applies to</div>
          <div className="flex rounded-lg border border-border overflow-hidden" role="group" aria-label="Which date the range filters">
            {[["sold", "Sold date"], ["install", "Install date"]].map(([k, label]) => (
              <button key={k} onClick={() => setBasis(k)} aria-pressed={basis === k}
                className={`px-3 py-1.5 text-xs font-semibold transition-colors ${basis === k ? "bg-accent text-white" : "bg-white text-muted-foreground hover:bg-secondary"}`}>
                {label}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-muted-foreground mt-1.5 max-w-[14rem]">
            {basis === "sold" ? "Jobs whose contract was signed in the range." : "Jobs whose first install visit starts in the range; unscheduled jobs have no date, so they drop out."}
          </div>
        </div>
      </div>

      {allowed && <NextActionsBar isManager={isManager} />}

      {isLoading || !t ? (
        error ? <p className="text-sm text-red-600">The pipeline could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {filtered && (
            <p className="text-xs text-muted-foreground">
              Showing {inRange.length} of {data.rows.length} pipeline jobs, by {basis === "sold" ? "sold date" : "install date"}. The cards add up what is showing; the two weekly cards are always the real calendar weeks.
            </p>
          )}
          {/* Headline totals — the numbers the CEO asked for, in his order. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9 gap-3">
            <Card tone="navy" label="Total Sold Pipeline" value={money(t.totalPipeline)} sub={`${t.jobs} sold jobs, not yet paid`} onClick={() => setBucket("all")} active={bucket === "all"} />
            <Card tone="green" label="Scheduled Pipeline" value={money(t.scheduled + t.inProduction)} sub={`${t.scheduledJobs} booked · ${t.inProductionJobs} in production`} onClick={() => setBucket("scheduled")} active={bucket === "scheduled"} />
            <Card tone="red" label="Unscheduled Sold Pipeline" value={money(t.unscheduled)}
              sub={`${t.unscheduledJobs} jobs with no production date · sold this month: ${money(t.unscheduledSoldThisMonth)} (${t.unscheduledSoldThisMonthJobs})`}
              onClick={() => setBucket("unscheduled")} active={bucket === "unscheduled"} />
            <Card tone="red" label="Sold Jobs Awaiting Production" value={t.awaitingProduction} sub="no install visit, stage not scheduled" onClick={() => setBucket("unscheduled")} active={bucket === "unscheduled"} />
            <Card tone={t.noContractValue > 0 ? "red" : "green"} label="No Contract Value in JobProgress" value={t.noContractValue}
              sub={t.noContractValue > 0 ? "every $ above is short by these" : "every job carries a price"} onClick={() => setNoValueOnly((v) => !v)} active={noValueOnly} />
            <Card tone="blue" label="Expected Production This Week" value={money(t.expectedThisWeek)} sub={`${t.expectedThisWeekJobs} install${t.expectedThisWeekJobs === 1 ? "" : "s"} starting ${fmtDay(data.thisWeek.from)} – ${fmtDay(data.thisWeek.to)}`} />
            <Card tone="blue" label="Expected Production Next Week" value={money(t.expectedNextWeek)} sub={`${t.expectedNextWeekJobs} install${t.expectedNextWeekJobs === 1 ? "" : "s"} starting ${fmtDay(data.nextWeek.from)} – ${fmtDay(data.nextWeek.to)}`} />
            <Card tone="blue" label="In Production" value={money(t.inProduction)} sub={`${t.inProductionJobs} jobs the crew has started`} onClick={() => setBucket("inProduction")} active={bucket === "inProduction"} />
            <Card tone="amber" label="Completed, Awaiting Payment" value={money(t.awaitingPayment)} sub={`${t.awaitingPaymentJobs} jobs built, money open`} onClick={() => setBucket("awaitingPayment")} active={bucket === "awaitingPayment"} />
          </div>

          {/* Detail */}
          <div className="bg-white rounded-xl border border-border shadow-sm">
            <div className="flex flex-wrap items-center gap-2 p-3 border-b border-border">
              <div className="flex flex-wrap gap-1.5">
                <Chip on={bucket === "all"} onClick={() => setBucket("all")}>All · {t.jobs}</Chip>
                {BUCKETS.map((b) => (
                  <Chip key={b.key} on={bucket === b.key} onClick={() => setBucket(b.key)}>{b.label} · {t[`${b.key}Jobs`]}</Chip>
                ))}
                <Chip on={noValueOnly} onClick={() => setNoValueOnly((v) => !v)} tone="red">No contract value · {t.noContractValue}</Chip>
              </div>
              <div className="relative ml-auto">
                <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Customer, job #, town, stage, owner…"
                  className="pl-8 pr-3 py-2 text-sm border border-input rounded-lg w-72" />
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="text-sm text-muted-foreground p-6 text-center">Nothing in this view.</p>
            ) : (
              <ScrollTable>
                <table className="w-full text-sm">
                  {/* Sticky header and sticky first column: the customer stays put while the wide part scrolls. */}
                  <thead className="sticky top-0 z-10 bg-secondary">
                    <tr className="text-left text-muted-foreground border-b border-border text-xs uppercase tracking-wide whitespace-nowrap">
                      <th className="px-3 py-2 sticky left-0 z-20 bg-secondary">Customer</th>
                      <th className="px-3 py-2">Town / Address</th>
                      <th className="px-3 py-2">Sold By</th>
                      <th className="px-3 py-2">Job #</th>
                      <th className="px-3 py-2">Trade</th>
                      <th className="px-3 py-2 text-right">Contract $</th>
                      <th className="px-3 py-2">Sold Date</th>
                      <th className="px-3 py-2 text-right">Days</th>
                      <th className="px-3 py-2">Current Stage</th>
                      <th className="px-3 py-2">Scheduled Date</th>
                      <th className="px-3 py-2">Expected Week</th>
                      <th className="px-3 py-2 min-w-[16rem]">Blocker</th>
                      <th className="px-3 py-2 min-w-[10rem]">Owner</th>
                      <th className="px-3 py-2 min-w-[18rem]">Next Action</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => <PipelineRow key={r.jobId} r={r} />)}
                  </tbody>
                </table>
              </ScrollTable>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PipelineRow({ r }) {
  const bucket = BUCKETS.find((b) => b.key === r.bucket);
  return (
    <tr className={`border-b border-border/50 hover:bg-secondary ${r.noContractValue ? "bg-red-50" : "bg-white"}`}>
      <td className="px-3 py-2 whitespace-nowrap sticky left-0 z-[1] bg-inherit shadow-[1px_0_0_0_hsl(var(--border))] font-semibold text-primary">{r.customer || "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">{[r.city, r.address].filter(Boolean).join(", ") || "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">{r.rep || "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap tabular-nums">{r.jobNumber || "—"}</td>
      <td className="px-3 py-2 whitespace-nowrap">{r.trades || r.division || "—"}</td>
      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.noContractValue ? "text-red-700" : ""}`} title={r.noContractValue ? "No contract value in JobProgress" : ""}>
        {r.noContractValue ? "none" : money(r.contract)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.contractSignedDate)}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.daysSinceSold > 90 && r.bucket === "unscheduled" ? "text-red-700 font-semibold" : ""}`}>{r.daysSinceSold}</td>
      <td className="px-3 py-2 whitespace-nowrap">
        <span className={`inline-block text-[11px] font-semibold px-1.5 py-0.5 rounded border mr-1.5 ${TONE[bucket?.tone ?? "slate"]}`}>{bucket?.label}</span>
        {r.stage || "—"}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.scheduledDate)}{r.nextInstallDate && r.nextInstallDate !== r.scheduledDate ? <div className="text-xs text-muted-foreground">next {fmtDay(r.nextInstallDate)}</div> : null}</td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtWeek(r.expectedWeek)}</td>
      <NoteCell r={r} field="blocker" value={r.blocker} derived={r.blockerDerived} />
      <NoteCell r={r} field="owner" value={r.owner} placeholder="assign…" />
      <NextActionCell r={r} />
      <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
    </tr>
  );
}

/** One editable note cell: click to edit, Enter or blur to save, Escape to cancel. */
function NoteCell({ r, field, value, derived = false, placeholder = "", startOpen = false, onClose }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditingState] = useState(startOpen);
  const [draft, setDraft] = useState("");
  const setEditing = (v) => { setEditingState(v); if (!v && onClose) onClose(); };
  const save = useMutation({
    mutationFn: (text) => productionApi.pipelineNote(r.jobId, {
      blocker: field === "blocker" ? text : (r.blockerDerived ? null : r.blocker),
      owner: field === "owner" ? text : r.owner,
      nextAction: field === "nextAction" ? text : r.nextAction,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["production-pipeline"] }); setEditing(false); },
    onError: (e) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  const start = () => { setDraft(derived ? "" : (value ?? "")); setEditing(true); };
  if (editing) {
    return (
      <td className="px-2 py-1">
        <div className="flex items-center gap-1">
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={derived ? value : placeholder}
            onKeyDown={(e) => { if (e.key === "Enter") save.mutate(draft); if (e.key === "Escape") setEditing(false); }}
            onBlur={() => save.mutate(draft)}
            className="text-sm border border-input rounded px-2 py-1 w-full min-w-[12rem]" />
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5 text-green-600" />}
        </div>
      </td>
    );
  }
  return (
    <td className="px-3 py-2 group cursor-text whitespace-normal break-words align-top" onClick={start}
      title={derived ? "Read from the JobProgress stage — click to write your own" : (r.noteUpdatedBy ? `${r.noteUpdatedBy}, ${new Date(r.noteUpdatedAt).toLocaleString()}` : "Click to edit")}>
      <span className={derived ? "text-muted-foreground italic" : value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
      <Pencil className="w-3 h-3 inline ml-1 opacity-0 group-hover:opacity-60" />
    </td>
  );
}

/**
 * Next Action: what a person wrote, else what the system suggests — in
 * italics, with one click to accept it or a pencil to write your own. The
 * suggestion never overwrites a person's note; accepting is the person's act.
 */
function NextActionCell({ r }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [writing, setWriting] = useState(false);
  const accept = useMutation({
    mutationFn: () => productionApi.acceptSuggestion(r.jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["production-pipeline"] }),
    onError: (e) => toast({ title: "Could not accept", description: e.message, variant: "destructive" }),
  });
  if (r.nextAction || writing || !r.suggested?.text) {
    return <NoteCell r={r} field="nextAction" value={r.nextAction} placeholder="what happens next…" startOpen={writing} onClose={() => setWriting(false)} />;
  }
  const s = r.suggested;
  const byRule = s.model === "rule" || s.model === "rule-fallback";
  const dot = s.confidence === "high" ? "bg-green-500" : s.confidence === "low" ? "bg-amber-500" : "bg-blue-500";
  return (
    <td className="px-3 py-2 whitespace-normal break-words align-top">
      <div className="flex items-start gap-1.5">
        <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${dot}`} title={`${s.confidence ?? "medium"} confidence · ${byRule ? "from the stage rule" : `from ${s.model}`}${s.at ? ` · ${new Date(s.at).toLocaleString()}` : ""}`} />
        <span className="italic text-muted-foreground"><span className="not-italic text-[10px] uppercase tracking-wide font-semibold mr-1">Suggested</span>{s.text}</span>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <button onClick={() => accept.mutate()} disabled={accept.isPending}
          className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:underline disabled:opacity-50" title="Make this the Next Action">
          {accept.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />} Accept
        </button>
        <button onClick={() => setWriting(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:underline" title="Write your own instead">
          <Pencil className="w-3 h-3" /> Write own
        </button>
      </div>
    </td>
  );
}

/** Run the suggestions now, see when they last ran and what it cost, and edit the instructions the model follows. */
function NextActionsBar({ isManager }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const { data: st } = useQuery({ queryKey: ["next-action-status"], queryFn: productionApi.nextActionStatus, staleTime: 30_000 });
  const run = useMutation({
    mutationFn: () => productionApi.suggestNextActions({}),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["production-pipeline"] }); qc.invalidateQueries({ queryKey: ["next-action-status"] });
      const c = res.counts;
      toast({ title: "Suggestions updated", description: `${c.suggested} suggested by the model, ${c.ruleOnly} by rule, ${c.unchanged} unchanged${c.estimatedCostUsd != null ? ` · about $${c.estimatedCostUsd.toFixed(3)}` : ""}.` });
    },
    onError: (e) => toast({ title: "Suggestion run failed", description: e.message, variant: "destructive" }),
  });
  const last = st?.lastRun;
  const cronLabel = st?.cron === "15 10 * * *" ? "nightly at 6:15am" : st?.cron ? `on schedule (${st.cron} UTC)` : "nightly";
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <Sparkles className="w-4 h-4 text-accent" />
        <div className="text-sm">
          <span className="font-semibold">Next-action suggestions</span>
          <span className="text-muted-foreground"> · {st?.enabled ? `${cronLabel} · ${st.model}` : (st?.reason || "off")}</span>
          {last && (
            <span className="text-muted-foreground"> · last run {new Date(last.startedAt).toLocaleString()}{last.status !== "completed" ? <span className="text-red-600"> failed{last.errorMessage ? `: ${last.errorMessage}` : ""}</span>
              : last.counts ? ` — ${last.counts.suggested} by model, ${last.counts.ruleOnly} by rule, ${last.counts.unchanged} unchanged${last.counts.estimatedCostUsd != null ? `, ~$${Number(last.counts.estimatedCostUsd).toFixed(3)}` : ""}` : ""}</span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setOpen((v) => !v)} className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground hover:text-primary">
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />} Instructions the AI follows
          </button>
          <button onClick={() => run.mutate()} disabled={run.isPending || !st?.enabled}
            className="bg-primary text-primary-foreground rounded-lg px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50" title={st?.enabled ? "Re-suggest for every job whose facts changed" : (st?.reason || "")}>
            {run.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />} Suggest next actions now
          </button>
        </div>
      </div>
      {open && <InstructionsEditor isManager={isManager} />}
    </div>
  );
}

function InstructionsEditor({ isManager }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading } = useQuery({ queryKey: ["next-action-instructions"], queryFn: productionApi.instructions });
  const [draft, setDraft] = useState(null);
  const text = draft ?? data?.body ?? "";
  const save = useMutation({
    mutationFn: () => productionApi.saveInstructions(text),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["next-action-instructions"] }); setDraft(null); toast({ title: "Instructions saved", description: "The next run will follow them. Press Suggest now to apply them today." }); },
    onError: (e) => toast({ title: "Could not save", description: e.message, variant: "destructive" }),
  });
  if (isLoading) return <div className="p-3"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></div>;
  return (
    <div className="border-t border-border p-3 space-y-2">
      <p className="text-xs text-muted-foreground max-w-3xl">
        These are the standing instructions the model works inside when it phrases a next action. Write them the way you would brief a new
        coordinator: what comes first, who owns what, when to escalate. The model cannot go outside them, and every suggestion is still
        just a suggestion until someone accepts it.
        {data?.isDefault ? " Showing the starter text; edit it and save to make it yours." : data?.updatedBy ? ` Last saved by ${data.updatedBy} on ${new Date(data.updatedAt).toLocaleString()}.` : ""}
        {!isManager && " Only managers can change it."}
      </p>
      <textarea value={text} onChange={(e) => setDraft(e.target.value)} readOnly={!isManager} rows={12}
        className="w-full text-sm border border-input rounded-lg px-3 py-2 font-mono leading-relaxed read-only:bg-secondary/40" />
      {isManager && (
        <div className="flex items-center gap-2">
          <button onClick={() => save.mutate()} disabled={save.isPending || draft === null || text.trim().length < 40}
            className="bg-accent text-white rounded-lg px-3 py-1.5 text-xs font-semibold disabled:opacity-50">{save.isPending ? "Saving…" : "Save instructions"}</button>
          {draft !== null && <button onClick={() => setDraft(null)} className="text-xs text-muted-foreground hover:underline">Discard changes</button>}
        </div>
      )}
    </div>
  );
}

function Card({ tone, label, value, sub, onClick, active }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag onClick={onClick} className={`text-left rounded-xl border p-3 shadow-sm ${TONE[tone]} ${onClick ? "hover:shadow-md" : ""} ${active ? "ring-2 ring-accent/50" : ""}`}>
      <div className={`text-[11px] uppercase tracking-wide font-semibold ${tone === "navy" ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{label}</div>
      <div className="text-2xl font-heading font-bold mt-0.5 tabular-nums">{value}</div>
      {sub && <div className={`text-[11px] mt-0.5 ${tone === "navy" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{sub}</div>}
    </Tag>
  );
}

function Chip({ on, onClick, children, tone }) {
  return (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
      on ? (tone === "red" ? "bg-red-600 text-white" : "bg-accent text-white") : "bg-secondary text-secondary-foreground hover:bg-secondary/70"}`}>
      {children}
    </button>
  );
}
