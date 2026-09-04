import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { PRODUCTION_ROLES } from "@allied/shared/constants";
import { STAGE_GROUPS } from "@allied/shared/jobStages";
import { RefreshCw, Loader2, ExternalLink, MapPin, Search, Users, CalendarDays, Clock } from "lucide-react";
import { productionApi } from "./api";
import ScheduleMap from "./ScheduleMap";

function relative(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 24 ? `${hrs} h ago` : new Date(iso).toLocaleString();
}
const fmtDay = (s) => (s ? new Date(`${s}T12:00:00Z`).toLocaleDateString(undefined, { timeZone: "UTC", month: "short", day: "numeric" }) : "");
const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());

export default function ProductionJobs() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && PRODUCTION_ROLES.includes(me.role);

  const [group, setGroup] = useState("production");
  const [stages, setStages] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [showMap, setShowMap] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const { data: board, isLoading, error } = useQuery({
    queryKey: ["production-jobs"], queryFn: productionApi.jobs, enabled: allowed, staleTime: 60_000, refetchInterval: 2 * 60_000,
  });

  const refresh = useMutation({
    mutationFn: productionApi.refresh,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["production-jobs"] });
      qc.invalidateQueries({ queryKey: ["production-board"] });
      const c = r.stages?.counts;
      toast({ title: "Refreshed from JobProgress", description: c ? `${c.jobs_examined} jobs in tracked stages, ${c.jobs_moved_out} moved on.` : "Schedule updated." });
    },
    onError: (err) => toast({ title: "Refresh failed", description: err.message, variant: "destructive" }),
  });

  const items = useMemo(() => {
    const all = board?.items ?? [];
    const q = search.trim().toLowerCase();
    return all
      .filter((i) => !group || i.stageGroup === group)
      .filter((i) => stages.size === 0 || stages.has(i.stageCode))
      .filter((i) => !q || [i.customerName, i.jobNumber, i.jobName, i.location?.address, i.location?.city, i.division]
        .some((v) => String(v ?? "").toLowerCase().includes(q)))
      .map((i, idx) => ({
        ...i, index: idx + 1,
        // Shape the map component expects (it was built for schedule items).
        parsed: { code: i.stageCode, label: i.stage, customer: i.customerName },
        status: i.nextVisit?.crews?.length ? "assigned" : "unassigned",
        crews: (i.nextVisit?.crews ?? []).map((n) => ({ id: n, name: n })),
        fullDay: true, startTime12: "", endTime12: "",
      }));
  }, [board, group, stages, search]);
  const mappable = items.filter((i) => i.location?.lat != null && i.location?.lng != null);

  const toggleStage = (code) => setStages((prev) => { const n = new Set(prev); if (n.has(code)) n.delete(code); else n.add(code); return n; });
  const pickGroup = (key) => { setGroup(key); setStages(new Set()); setSelectedId(null); };

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Production access required.</div>;

  const current = board?.groups?.find((g) => g.key === group);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Jobs by Stage</h1>
          <p className="text-sm text-muted-foreground">
            Every job in the Project Won, Production and Warranty stages, straight from the JobProgress workflow.
            {board?.sync && <span className={board.sync.status === "completed" ? "" : "text-red-600"}> Updated {relative(board.sync.finishedAt || board.sync.startedAt)}.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowMap((v) => !v)} className={`flex items-center gap-2 border text-sm font-semibold px-3 py-2 rounded-lg ${showMap ? "bg-primary text-primary-foreground border-primary" : "bg-white border-border hover:bg-secondary"}`}>
            <MapPin className="w-4 h-4" /> Map
          </button>
          <button onClick={() => refresh.mutate()} disabled={refresh.isPending}
            className="flex items-center gap-2 bg-white border border-border hover:bg-secondary disabled:opacity-50 text-sm font-semibold px-3 py-2 rounded-lg">
            {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Refresh from JobProgress
          </button>
        </div>
      </div>

      {/* Groups, like the JobProgress Jobs screen */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {STAGE_GROUPS.map((g) => {
          const info = board?.groups?.find((x) => x.key === g.key);
          const on = group === g.key;
          return (
            <button key={g.key} onClick={() => pickGroup(g.key)}
              className={`text-left rounded-xl border p-4 shadow-sm transition-colors ${on ? "border-transparent text-white" : "bg-white border-border hover:bg-secondary"}`}
              style={on ? { background: g.color } : undefined}>
              <div className={`text-[11px] uppercase tracking-wide font-semibold ${on ? "text-white/80" : "text-muted-foreground"}`}>{g.label}</div>
              <div className="text-2xl font-heading font-bold mt-1">{info ? info.count : "—"}</div>
            </button>
          );
        })}
      </div>

      {current && (
        <div className="bg-white rounded-xl border border-border shadow-sm p-3 flex flex-wrap items-center gap-1.5">
          {current.stages.map((s) => {
            const on = stages.size === 0 || stages.has(s.code);
            return (
              <button key={s.code} onClick={() => toggleStage(s.code)}
                title={s.jobsCount != null && s.jobsCount !== s.count ? `JobProgress shows ${s.jobsCount} in this stage; ${s.count} synced so far.` : undefined}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                  on ? "bg-white border-border" : "bg-secondary/60 border-transparent text-muted-foreground line-through"}`}>
                {s.name} <span className="text-muted-foreground">{s.count}</span>
              </button>
            );
          })}
          {stages.size > 0 && <button onClick={() => setStages(new Set())} className="text-xs text-accent font-semibold px-2">Show all</button>}
          <div className="ml-auto relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-2 text-muted-foreground" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer, job #, town…"
              className="border border-input rounded-lg pl-7 pr-2 py-1 text-sm bg-white w-56" />
          </div>
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error.message}</div>}

      <div className={`grid grid-cols-1 gap-4 items-start ${showMap ? "lg:grid-cols-[minmax(0,1fr)_480px]" : ""}`}>
        <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {board?.items?.length ? "No jobs match these filters." : "No jobs synced yet — press Refresh from JobProgress."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-max">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground border-b border-border bg-secondary/40">
                    <th className="px-3 py-2">#</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Job</th>
                    <th className="px-3 py-2">Stage</th>
                    <th className="px-3 py-2 text-right" title="Whole days since the job entered its current stage">Days in stage</th>
                    <th className="px-3 py-2">Next visit</th>
                    <th className="px-3 py-2">Crew</th>
                    <th className="px-3 py-2">Town</th>
                    <th className="px-3 py-2 text-right">Price</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.id} onClick={() => setSelectedId(i.id === selectedId ? null : i.id)}
                      className={`border-b border-border/50 cursor-pointer ${i.id === selectedId ? "bg-accent/10" : "hover:bg-secondary/30"}`}>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{i.index}</td>
                      <td className="px-3 py-2 font-semibold text-primary whitespace-nowrap">{i.customerName || i.jobName || "—"}{i.insurance && <span className="ml-1 text-[10px] font-bold px-1.5 rounded bg-indigo-100 text-indigo-700">INS</span>}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{i.jobNumber}<div className="text-muted-foreground">{i.division}</div></td>
                      <td className="px-3 py-2 whitespace-nowrap"><span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-secondary">{i.stage}</span></td>
                      <td className={`px-3 py-2 text-right font-semibold ${i.daysInStage > 30 ? "text-red-600" : i.daysInStage > 14 ? "text-amber-700" : ""}`}>{i.daysInStage ?? "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{i.nextVisit ? <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3 text-muted-foreground" />{fmtDay(i.nextVisit.startDay)}</span> : <span className="text-muted-foreground">not scheduled</span>}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-xs">{i.nextVisit?.crews?.length ? <span className="flex items-center gap-1"><Users className="w-3 h-3 text-muted-foreground" />{i.nextVisit.crews.join(", ")}</span> : ""}</td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">{i.location?.city || "—"}{i.location && i.location.lat == null && <span className="ml-1 text-[10px] text-amber-700">no map</span>}</td>
                      <td className="px-3 py-2 text-right text-xs">{money(i.totalJobPrice)}</td>
                      <td className="px-3 py-2">{i.jpUrl && <a href={i.jpUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent" title="Open in JobProgress"><ExternalLink className="w-4 h-4" /></a>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {items.length > 0 && (
            <div className="px-3 py-2 text-xs text-muted-foreground border-t border-border flex items-center gap-2">
              <Clock className="w-3 h-3" /> {items.length} job{items.length === 1 ? "" : "s"} · sorted by stage, longest waiting first
            </div>
          )}
        </div>
        {showMap && (
          <div className="lg:sticky lg:top-20 bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="h-[420px] lg:h-[calc(100vh-13rem)]">
              <ScheduleMap items={mappable} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            <div className="p-3 border-t border-border text-[11px] text-muted-foreground">
              Pins numbered like the list. {items.length - mappable.length > 0 && <span className="text-amber-700 font-medium">{items.length - mappable.length} without a map location.</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
