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
import { PRODUCTION_ROLES } from "@allied/shared/constants";
import { BUCKETS } from "@allied/shared/soldPipeline";
import { Loader2, ExternalLink, Search, Pencil, Check } from "lucide-react";
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
  const allowed = !!me && PRODUCTION_ROLES.includes(me.role);
  const { data, isLoading, error } = useQuery({ queryKey: ["production-pipeline"], queryFn: productionApi.pipeline, enabled: allowed, staleTime: 60_000 });
  const [bucket, setBucket] = useState("unscheduled");
  const [q, setQ] = useState("");
  const [noValueOnly, setNoValueOnly] = useState(false);

  const rows = useMemo(() => {
    let list = data?.rows ?? [];
    if (bucket !== "all") list = list.filter((r) => r.bucket === bucket);
    if (noValueOnly) list = list.filter((r) => r.noContractValue);
    const s = q.trim().toLowerCase();
    if (s) list = list.filter((r) => [r.customer, r.jobNumber, r.city, r.address, r.stage, r.rep, r.owner, r.blocker, r.nextAction].some((v) => String(v ?? "").toLowerCase().includes(s)));
    return list;
  }, [data, bucket, q, noValueOnly]);

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Production access required.</div>;
  const t = data?.totals;

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

      {isLoading || !t ? (
        error ? <p className="text-sm text-red-600">The pipeline could not be loaded right now.</p>
          : <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : (
        <>
          {/* Headline totals — the numbers the CEO asked for, in his order. */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <Card tone="navy" label="Total Sold Pipeline" value={money(t.totalPipeline)} sub={`${t.jobs} sold jobs, not yet paid`} onClick={() => setBucket("all")} active={bucket === "all"} />
            <Card tone="green" label="Scheduled Pipeline" value={money(t.scheduled + t.inProduction)} sub={`${t.scheduledJobs} booked · ${t.inProductionJobs} in production`} onClick={() => setBucket("scheduled")} active={bucket === "scheduled"} />
            <Card tone="red" label="Unscheduled Sold Pipeline" value={money(t.unscheduled)} sub={`${t.unscheduledJobs} jobs with no production date`} onClick={() => setBucket("unscheduled")} active={bucket === "unscheduled"} />
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
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-muted-foreground bg-secondary/50 border-b border-border text-xs uppercase tracking-wide">
                      <th className="px-3 py-2">Customer</th>
                      <th className="px-3 py-2">Job</th>
                      <th className="px-3 py-2 text-right">Contract $</th>
                      <th className="px-3 py-2">Sold</th>
                      <th className="px-3 py-2 text-right">Days</th>
                      <th className="px-3 py-2">Current Stage</th>
                      <th className="px-3 py-2">Scheduled Date</th>
                      <th className="px-3 py-2">Expected Week</th>
                      <th className="px-3 py-2">Blocker</th>
                      <th className="px-3 py-2">Owner</th>
                      <th className="px-3 py-2">Next Action</th>
                      <th className="px-3 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => <PipelineRow key={r.jobId} r={r} />)}
                  </tbody>
                </table>
              </div>
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
    <tr className={`border-b border-border/50 hover:bg-secondary/30 ${r.noContractValue ? "bg-red-50/40" : ""}`}>
      <td className="px-3 py-2 whitespace-nowrap">
        <div className="font-semibold text-primary">{r.customer || "—"}</div>
        <div className="text-xs text-muted-foreground">{[r.city, r.address].filter(Boolean).join(" · ")}{r.rep ? ` · sold by ${r.rep}` : ""}</div>
      </td>
      <td className="px-3 py-2 whitespace-nowrap text-xs">{r.jobNumber || "—"}<div className="text-muted-foreground">{r.trades || r.division || ""}</div></td>
      <td className={`px-3 py-2 text-right tabular-nums font-semibold ${r.noContractValue ? "text-red-700" : ""}`} title={r.noContractValue ? "No contract value in JobProgress" : ""}>
        {r.noContractValue ? "none" : money(r.contract)}
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.contractSignedDate)}</td>
      <td className={`px-3 py-2 text-right tabular-nums ${r.daysSinceSold > 90 && r.bucket === "unscheduled" ? "text-red-700 font-semibold" : ""}`}>{r.daysSinceSold}</td>
      <td className="px-3 py-2">
        <span className={`inline-block text-[11px] font-semibold px-1.5 py-0.5 rounded border mr-1 ${TONE[bucket?.tone ?? "slate"]}`}>{bucket?.label}</span>
        <span className="text-xs">{r.stage || "—"}</span>
      </td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtDay(r.scheduledDate)}{r.nextInstallDate && r.nextInstallDate !== r.scheduledDate ? <div className="text-xs text-muted-foreground">next {fmtDay(r.nextInstallDate)}</div> : null}</td>
      <td className="px-3 py-2 whitespace-nowrap">{fmtWeek(r.expectedWeek)}</td>
      <NoteCell r={r} field="blocker" value={r.blocker} derived={r.blockerDerived} />
      <NoteCell r={r} field="owner" value={r.owner} placeholder="assign…" />
      <NoteCell r={r} field="nextAction" value={r.nextAction} placeholder="what happens next…" />
      <td className="px-3 py-2">{r.jpUrl && <a href={r.jpUrl} target="_blank" rel="noreferrer" className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
    </tr>
  );
}

/** One editable note cell: click to edit, Enter or blur to save, Escape to cancel. */
function NoteCell({ r, field, value, derived = false, placeholder = "" }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
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
            className="text-sm border border-input rounded px-2 py-1 w-44" />
          {save.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5 text-green-600" />}
        </div>
      </td>
    );
  }
  return (
    <td className="px-3 py-2 group cursor-text max-w-[16rem]" onClick={start}
      title={derived ? "Read from the JobProgress stage — click to write your own" : (r.noteUpdatedBy ? `${r.noteUpdatedBy}, ${new Date(r.noteUpdatedAt).toLocaleString()}` : "Click to edit")}>
      <span className={derived ? "text-muted-foreground italic" : value ? "" : "text-muted-foreground"}>{value || placeholder}</span>
      <Pencil className="w-3 h-3 inline ml-1 opacity-0 group-hover:opacity-60" />
    </td>
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
