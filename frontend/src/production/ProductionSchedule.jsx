import { useState, useMemo, useEffect, useRef, forwardRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { PRODUCTION_ROLES } from "@allied/shared/constants";
import { jobTypeColor, STATUS_LABELS } from "@allied/shared/production";
import {
  ChevronLeft, ChevronRight, RefreshCw, MapPin, ExternalLink, CheckCircle2,
  AlertTriangle, Loader2, CalendarDays, Users, Clock, Filter,
} from "lucide-react";
import { productionApi } from "./api";
import ScheduleMap from "./ScheduleMap";

// ── Date helpers (all on YYYY-MM-DD strings; the board is in New York time) ──
const BOARD_TZ = "America/New_York";
const todayInBoardZone = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: BOARD_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const toUtc = (s) => new Date(`${s}T12:00:00Z`);
const fromUtc = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => fromUtc(new Date(toUtc(s).getTime() + n * 86_400_000));
const diffDays = (a, b) => Math.round((toUtc(a) - toUtc(b)) / 86_400_000);
function weekOf(s) {
  const d = toUtc(s);
  const monday = addDays(s, -((d.getUTCDay() + 6) % 7));
  return { from: monday, to: addDays(monday, 6) };
}
const fmtLong = (s) => toUtc(s).toLocaleDateString(undefined,
  { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
const fmtShort = (s) => toUtc(s).toLocaleDateString(undefined,
  { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
function fmtTime(hhmm) {
  if (!hhmm) return "";
  const [h, m] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${suffix}`;
}
function relative(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  return new Date(iso).toLocaleString();
}

const NO_CREW = "__none__";

export default function ProductionSchedule() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && PRODUCTION_ROLES.includes(me.role);

  const [date, setDate] = useState(todayInBoardZone);
  const [view, setView] = useState("day");
  const [crew, setCrew] = useState("");
  const [types, setTypes] = useState(() => new Set());
  const [hideCompleted, setHideCompleted] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const cardRefs = useRef({});

  const range = view === "day" ? { date } : weekOf(date);
  const { data: board, isLoading, error, isFetching } = useQuery({
    queryKey: ["production-board", range],
    queryFn: () => productionApi.board(range),
    enabled: allowed,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  });

  const refresh = useMutation({
    mutationFn: productionApi.refresh,
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["production-board"] });
      toast({
        title: "Schedule refreshed",
        description: `${r.counts.schedules_examined} scheduled jobs read from JobProgress`
          + (r.counts.schedules_created ? `, ${r.counts.schedules_created} new` : "")
          + (r.counts.schedules_retired ? `, ${r.counts.schedules_retired} removed` : "") + ".",
      });
    },
    onError: (err) => toast({ title: "Refresh failed", description: err.message, variant: "destructive" }),
  });

  // Filtered list, numbered so the cards and the pins share labels.
  const items = useMemo(() => {
    const all = board?.items ?? [];
    return all
      .filter((i) => !hideCompleted || i.status !== "completed")
      .filter((i) => !crew || (crew === NO_CREW ? i.crews.length === 0 : i.crews.some((c) => c.id === crew)))
      .filter((i) => types.size === 0 || types.has(i.parsed.code ?? ""))
      .map((i, idx) => ({
        ...i, index: idx + 1,
        startTime12: fmtTime(i.startTime), endTime12: fmtTime(i.endTime),
      }));
  }, [board, hideCompleted, crew, types]);
  const mappable = useMemo(() => items.filter((i) => i.location?.lat != null && i.location?.lng != null), [items]);

  const counts = useMemo(() => {
    const all = board?.items ?? [];
    return {
      total: all.length,
      assigned: all.filter((i) => i.status === "assigned").length,
      unassigned: all.filter((i) => i.status === "unassigned").length,
      completed: all.filter((i) => i.status === "completed").length,
    };
  }, [board]);

  useEffect(() => { setSelectedId(null); }, [date, view, crew, types, hideCompleted]);
  useEffect(() => {
    if (selectedId) cardRefs.current[selectedId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selectedId]);

  const toggleType = (code) => setTypes((prev) => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  if (me && !allowed) {
    return <div className="py-20 text-center text-muted-foreground">Production access required.</div>;
  }

  const step = view === "day" ? 1 : 7;

  return (
    <div className="space-y-4">
      {/* Title row */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Production Schedule</h1>
          <p className="text-sm text-muted-foreground">
            Installs from the JobProgress production calendar, in New York time.
            {board?.sync ? (
              <span className={board.sync.status === "completed" ? "" : "text-red-600"}>
                {" "}Updated {relative(board.sync.finishedAt || board.sync.startedAt)}
                {board.sync.status !== "completed" ? ` (last sync ${board.sync.status})` : ""}.
              </span>
            ) : board ? <span className="text-amber-700"> Not synced yet — press Refresh.</span> : null}
          </p>
        </div>
        <button
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
          className="flex items-center gap-2 bg-white border border-border hover:bg-secondary disabled:opacity-50 text-sm font-semibold px-3 py-2 rounded-lg transition-colors">
          {refresh.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh from JobProgress
        </button>
      </div>

      {/* Day navigation + view */}
      <div className="bg-white rounded-xl border border-border shadow-sm p-3 flex flex-wrap items-center gap-2">
        <button onClick={() => setDate(addDays(date, -step))} className="p-2 rounded-lg hover:bg-secondary" aria-label="Previous">
          <ChevronLeft className="w-4 h-4" />
        </button>
        <button onClick={() => setDate(todayInBoardZone())} className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-secondary hover:bg-secondary/70">
          Today
        </button>
        <button onClick={() => setDate(addDays(date, step))} className="p-2 rounded-lg hover:bg-secondary" aria-label="Next">
          <ChevronRight className="w-4 h-4" />
        </button>
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)}
          className="border border-input rounded-lg px-2 py-1.5 text-sm bg-white" />
        <div className="font-heading font-bold text-primary text-sm sm:text-base ml-1 flex items-center gap-2">
          <CalendarDays className="w-4 h-4 text-accent" />
          {view === "day" ? fmtLong(date) : `${fmtShort(range.from)} – ${fmtShort(range.to)}`}
          {isFetching && !isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />}
        </div>
        <div className="ml-auto flex rounded-lg border border-border overflow-hidden text-xs font-semibold">
          {["day", "week"].map((v) => (
            <button key={v} onClick={() => setView(v)}
              className={`px-3 py-1.5 capitalize ${view === v ? "bg-primary text-primary-foreground" : "bg-white hover:bg-secondary"}`}>
              {v}
            </button>
          ))}
        </div>
      </div>

      {/* Summary + filters */}
      <div className="flex flex-wrap items-center gap-2">
        <Stat label="Scheduled" value={counts.total} />
        <Stat label="Assigned" value={counts.assigned} tone="text-emerald-700 bg-emerald-50 border-emerald-200" />
        <Stat label="No crew" value={counts.unassigned} tone={counts.unassigned ? "text-red-700 bg-red-50 border-red-200" : undefined} />
        <Stat label="Completed" value={counts.completed} tone="text-slate-600 bg-slate-50 border-slate-200" />
        <div className="flex items-center gap-2 ml-auto">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <select value={crew} onChange={(e) => setCrew(e.target.value)}
            className="border border-input rounded-lg px-2 py-1.5 text-sm bg-white max-w-[180px]">
            <option value="">All crews</option>
            <option value={NO_CREW}>No crew assigned</option>
            {(board?.crews ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="flex items-center gap-1.5 text-sm select-none">
            <input type="checkbox" checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} />
            Hide completed
          </label>
        </div>
      </div>
      {(board?.jobTypes?.length ?? 0) > 1 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {board.jobTypes.map((t) => {
            const key = t.code ?? "";
            const on = types.size === 0 || types.has(key);
            return (
              <button key={key} onClick={() => toggleType(key)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border transition-colors ${
                  on ? "bg-white border-border" : "bg-secondary/60 border-transparent text-muted-foreground line-through"}`}>
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: jobTypeColor(t.code) }} />
                {t.label} <span className="text-muted-foreground">{t.count}</span>
              </button>
            );
          })}
          {types.size > 0 && (
            <button onClick={() => setTypes(new Set())} className="text-xs text-accent font-semibold px-2">Show all</button>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-xl p-4 text-sm">{error.message}</div>
      )}

      {/* Board */}
      <div className="grid grid-cols-1 lg:grid-cols-[400px_minmax(0,1fr)] gap-4 items-start">
        {/* Map — first on phones, sticky on desktop */}
        <div className="order-first lg:order-none lg:col-start-2 lg:row-start-1 lg:sticky lg:top-20">
          <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
            <div className="h-[340px] lg:h-[calc(100vh-13rem)] min-h-[320px]">
              <ScheduleMap items={mappable} selectedId={selectedId} onSelect={setSelectedId} />
            </div>
            <div className="p-3 border-t border-border flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
              <LegendPin label="Assigned" style={{ background: "#1d4ed8", borderColor: "#1d4ed8" }} />
              <LegendPin label="No crew assigned" style={{ background: "#fff", borderColor: "#1d4ed8", borderStyle: "dashed" }} />
              <LegendPin label="Completed" style={{ background: "#9ca3af", borderColor: "#6b7280" }} />
              <span className="ml-auto">Colour = job type.</span>
              {items.length - mappable.length > 0 && (
                <span className="text-amber-700 font-medium">
                  {items.length - mappable.length} job{items.length - mappable.length === 1 ? "" : "s"} without a map location
                </span>
              )}
            </div>
          </div>
        </div>

        {/* List */}
        <div className="lg:col-start-1 lg:row-start-1 space-y-2 lg:max-h-[calc(100vh-10rem)] lg:overflow-y-auto scroll-subtle lg:pr-1">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
          ) : items.length === 0 ? (
            <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground">
              <MapPin className="w-10 h-10 mx-auto mb-2 opacity-40" />
              {board?.items?.length ? "Nothing matches these filters." : "Nothing scheduled."}
            </div>
          ) : (
            items.map((item, idx) => {
              const prev = items[idx - 1];
              const showDayHeading = view === "week" && (!prev || prev.startDay !== item.startDay);
              return (
                <div key={item.id}>
                  {showDayHeading && (
                    <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground px-1 pt-2 pb-1">
                      {item.startDay < range.from ? `Started earlier (${fmtShort(item.startDay)})` : fmtLong(item.startDay)}
                    </div>
                  )}
                  <ScheduleCard
                    item={item}
                    day={view === "day" ? date : null}
                    selected={item.id === selectedId}
                    onSelect={() => setSelectedId(item.id === selectedId ? null : item.id)}
                    ref={(el) => { if (el) cardRefs.current[item.id] = el; }}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm ${tone ?? "bg-white border-border"}`}>
      <span className="font-bold">{value}</span>
      <span className="text-xs">{label}</span>
    </div>
  );
}

function LegendPin({ label, style }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-3 rounded-full border-2" style={style} />
      {label}
    </span>
  );
}

const ScheduleCard = forwardRef(function ScheduleCard({ item, day, selected, onSelect }, ref) {
  const color = jobTypeColor(item.parsed.code);
  const address = item.location?.address
    ? [item.location.address, item.location.city].filter(Boolean).join(", ")
    : [item.parsed.address, item.parsed.town].filter(Boolean).join(", ");
  const noPin = item.location?.lat == null;
  const dayOf = day && item.multiDay
    ? `Day ${diffDays(day, item.startDay) + 1} of ${diffDays(item.endDay, item.startDay) + 1}`
    : null;

  return (
    <div ref={ref} onClick={onSelect}
      className={`bg-white rounded-xl border p-3 shadow-sm cursor-pointer transition-shadow hover:shadow-md ${
        selected ? "border-accent ring-2 ring-accent/30" : "border-border"}`}>
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-white text-xs font-bold"
          style={{ background: item.status === "completed" ? "#9ca3af" : color }}>
          {item.index}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="font-bold uppercase tracking-wide" style={{ color }}>{item.parsed.label}</span>
            <span className="text-muted-foreground flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {item.fullDay ? "All day" : `${item.startTime12} – ${item.endTime12}`}
              {item.multiDay && !dayOf && ` · ${fmtShort(item.startDay)} → ${fmtShort(item.endDay)}`}
              {dayOf && ` · ${dayOf}`}
            </span>
          </div>
          <div className="font-bold text-primary truncate mt-0.5">
            {item.customerName || item.parsed.customer || item.title}
            {item.jobNumber && <span className="ml-2 text-xs font-medium text-muted-foreground">{item.jobNumber}</span>}
          </div>
          <div className="text-xs text-foreground/80 flex items-center gap-1 mt-0.5">
            <MapPin className="w-3 h-3 text-muted-foreground shrink-0" />
            <span className="truncate">{address || "No address"}</span>
            {noPin && <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 px-1.5 rounded ml-1">no map location</span>}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {item.status === "completed" ? (
              <Badge tone="bg-slate-100 text-slate-600"><CheckCircle2 className="w-3 h-3" /> {STATUS_LABELS.completed}</Badge>
            ) : item.crews.length === 0 ? (
              <Badge tone="bg-red-50 text-red-700"><AlertTriangle className="w-3 h-3" /> {STATUS_LABELS.unassigned}</Badge>
            ) : (
              item.crews.map((c) => (
                <Badge key={c.id} tone="bg-emerald-50 text-emerald-800"><Users className="w-3 h-3" /> {c.name}</Badge>
              ))
            )}
            {item.insurance && <Badge tone="bg-indigo-100 text-indigo-700">Insurance</Badge>}
            {item.jpUrl && (
              <a href={item.jpUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
                className="ml-auto text-xs font-semibold text-accent hover:underline flex items-center gap-1">
                Open in JobProgress <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

function Badge({ children, tone }) {
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full ${tone}`}>
      {children}
    </span>
  );
}
