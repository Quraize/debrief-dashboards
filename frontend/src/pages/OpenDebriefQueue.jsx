import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { ClipboardList, Loader2, Filter, Plus, Send, Phone, Mail, ExternalLink, Database, AlertTriangle } from "lucide-react";
import { ESTIMATING_IN_PROGRESS_OUTCOME, DEMO_NO_SALE_OUTCOME, QUEUE_DATE_FILTERS, ALL_TIME_FILTER } from "@allied/shared/constants";
import { filterByDate } from "@allied/shared/kpi";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { isInsuranceAppointment } from "@allied/shared/insurance";
import {
  indexJpAppointments, indexById, enrichQueueItem, queueDisposition, localDay, CRM_STATUS_LABELS, isImportant, OVERDUE_DAYS,
  debriefIndex, hasDebriefFor,
} from "@allied/shared/debriefQueue";
import { useJpMirror, useJpCustomers } from "@/components/JpCrmSection";
import DateRangeFilter from "@/components/DateRangeFilter";
import { usDate, simpleTime } from "@/lib/format";

// What to list. Combines with the date range and the people filters below.
const VIEWS = ["Missing Debrief","Excluded by CRM","Needs Review","All Appointments","Estimates in Progress"];

const VIEW_HELP = {
  "Missing Debrief": "Sales appointments that have happened and have no debrief yet. Appointments the CRM marked No See, cancelled, or that never got a CRM result are not counted — see Excluded by CRM.",
  "Excluded by CRM": "Past appointments without a debrief that the CRM says were not run: No See, cancelled, or no result form after 14 days. Nothing to debrief, listed so nothing disappears silently.",
  "Needs Review": "Appointments a manager flagged for a second look.",
  "All Appointments": "Every sales appointment in the date range, debriefed or not, so a manager can review a day or a week.",
  "Estimates in Progress": "Debriefs left as Estimating in Progress. Mark the estimate sent when it goes out.",
};
const IMPORTANT_HELP = `Only the missing debriefs that matter most: the CRM recorded a Sale with no debrief behind it, or the appointment is ${OVERDUE_DAYS}+ days old and still not debriefed.`;

export default function OpenDebriefQueue() {
  const [view, setView] = useState("Missing Debrief");
  const [range, setRange] = useState(ALL_TIME_FILTER);
  const [cs, setCs] = useState("");
  const [ce, setCe] = useState("");
  const [importantOnly, setImportantOnly] = useState(false);
  const qc = useQueryClient();
  const [markingId, setMarkingId] = useState(null);

  const { data: appointments = [], isLoading } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-appointment_date", 500)
  });

  const { data: debriefs = [] } = useQuery({
    queryKey: ["debriefs-all"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });

  // The CRM mirror: result forms, leads and jobs. Loaded once, cached like the dashboards.
  const { jpAppointments, jpJobs, isLoading: jpLoading } = useJpMirror();
  const { customers } = useJpCustomers();
  const crmCtx = useMemo(() => ({
    jpByKey: indexJpAppointments(jpAppointments),
    customersById: indexById(customers, "jp_customer_id"),
    jobsById: indexById(jpJobs, "jp_job_id"),
  }), [jpAppointments, customers, jpJobs]);

  // Retired rows (rescheduled or deleted in the CRM) are history, not work.
  const salesAppts = useMemo(() => salesAppointmentsOnly(appointments).filter((a) => !a.retired_at), [appointments]);
  const reps = useMemo(() => [...new Set(salesAppts.map((a) => a.original_sales_rep).filter(Boolean))], [salesAppts]);
  const setters = useMemo(() => [...new Set(salesAppts.map((a) => a.original_appointment_setter).filter(Boolean))], [salesAppts]);
  const [rep, setRep] = useState("");
  const [setter, setSetter] = useState("");

  const now = new Date();
  const todayStr = localDay(now);

  // Debriefs that exist, by every link a debrief can carry (Lead ID + date,
  // appointment row, JobProgress appointment id) — the same three the submit
  // form uses to detect a duplicate. The appointment's own debrief_status can
  // lag, so the queue cross-checks rather than trusting it.
  const debriefKeys = useMemo(() => debriefIndex(debriefs), [debriefs]);
  const hasDebrief = (a) => hasDebriefFor(a, debriefKeys);

  // Every sales appointment, joined to the CRM and classified once.
  const items = useMemo(() => salesAppts.map((a) => {
    const extra = enrichQueueItem(a, crmCtx, now);
    return { a, ...extra, debriefed: hasDebrief(a), disposition: queueDisposition(a, extra.crm, hasDebrief(a), now) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [salesAppts, crmCtx, debriefKeys, todayStr]);

  // Date range and people filters apply to every view; the view picks the status.
  const scoped = useMemo(() => {
    const dated = items.map((i) => ({ ...i, appointment_date: i.a.appointment_date }));
    return filterByDate(dated, "appointment_date", range, cs, ce).filter(({ a }) =>
      (!rep || a.original_sales_rep === rep || a.rehash_sales_rep === rep) &&
      (!setter || a.original_appointment_setter === setter || a.rehash_appointment_setter === setter));
  }, [items, range, cs, ce, rep, setter]);

  const inView = (item, v) => {
    switch (v) {
      case "Missing Debrief": return item.disposition === "missing";
      case "Excluded by CRM": return item.disposition === "excluded";
      case "Needs Review": return item.a.debrief_status === "Needs Review";
      case "All Appointments": return true;
      default: return false;
    }
  };

  const counts = useMemo(() => {
    const c = {};
    for (const v of VIEWS) if (v !== "Estimates in Progress") c[v] = scoped.filter((i) => inView(i, v)).length;
    c.important = scoped.filter(isImportant).length;
    return c;
  }, [scoped]);

  const queue = useMemo(() => {
    return scoped
      .filter((i) => inView(i, view) && (!importantOnly || isImportant(i)))
      .sort((x, y) => (y.a.appointment_date || "").localeCompare(x.a.appointment_date || ""));
  }, [scoped, view, importantOnly]);

  const estimatesInProgress = useMemo(() => {
    const rows = debriefs.filter((d) => d.appointment_outcome === ESTIMATING_IN_PROGRESS_OUTCOME);
    return filterByDate(rows, "appointment_date", range, cs, ce)
      .filter((d) => !rep || d.sales_rep === rep)
      .filter((d) => !setter || d.appointment_setter === setter)
      .sort((a, b) => (b.appointment_date || "").localeCompare(a.appointment_date || ""));
  }, [debriefs, range, cs, ce, rep, setter]);

  async function markEstimateSent(debrief) {
    setMarkingId(debrief.id);
    try {
      await base44.entities.Debrief.update(debrief.id, {
        estimate_sent_date: new Date().toISOString(),
        appointment_outcome: DEMO_NO_SALE_OUTCOME,
        follow_up_needed: true
      });
      qc.invalidateQueries({ queryKey: ["debriefs-all"] });
      qc.invalidateQueries({ queryKey: ["debriefs"] });
    } finally {
      setMarkingId(null);
    }
  }

  function daysOpen(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr + "T00:00:00");
    const diff = Math.floor((Date.now() - d.getTime()) / 86400000);
    return diff >= 0 ? `${diff} day${diff === 1 ? "" : "s"}` : "—";
  }

  const showEstimates = view === "Estimates in Progress";
  // Wait for the CRM mirror too: without it a No See would flash into the
  // Missing view and out again as the join arrives.
  const loading = isLoading || jpLoading;
  const crmMissing = !jpLoading && jpAppointments.length === 0;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Open Debrief Queue</h1>
        <p className="text-sm text-muted-foreground">
          Appointments that have happened and have no debrief yet.
          {!loading && !showEstimates && <> <span className="font-semibold text-foreground">{queue.length}</span> in this view.</>}
        </p>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-muted-foreground shrink-0" />
        {VIEWS.map((v) => (
          <button key={v} onClick={() => setView(v)} title={VIEW_HELP[v]}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              view === v ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {v}
            {counts[v] != null && !loading && (
              <span className={`text-[10px] px-1.5 rounded-full ${view === v ? "bg-white/25" : "bg-secondary text-muted-foreground"}`}>{counts[v]}</span>
            )}
          </button>
        ))}
        {!showEstimates && (
          <button onClick={() => setImportantOnly((v) => !v)} title={IMPORTANT_HELP}
            className={`ml-auto px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors flex items-center gap-1.5 ${
              importantOnly ? "bg-red-600 text-white" : "bg-white border border-red-200 text-red-700"
            }`}>
            <AlertTriangle className="w-3.5 h-3.5" /> Important only
            {!loading && <span className={`text-[10px] px-1.5 rounded-full ${importantOnly ? "bg-white/25" : "bg-red-50"}`}>{counts.important}</span>}
          </button>
        )}
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        {VIEW_HELP[view]}{importantOnly && !showEstimates ? ` ${IMPORTANT_HELP}` : ""}
      </p>

      <DateRangeFilter filter={range} setFilter={setRange} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe}
        filters={QUEUE_DATE_FILTERS} className="" />

      <div className="flex flex-wrap items-center gap-2">
        <select className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" value={rep} onChange={(e) => setRep(e.target.value)}>
          <option value="">All sales reps</option>
          {reps.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <select className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" value={setter} onChange={(e) => setSetter(e.target.value)}>
          <option value="">All setters</option>
          {setters.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {(rep || setter || range !== ALL_TIME_FILTER || importantOnly) && (
          <button onClick={() => { setRep(""); setSetter(""); setRange(ALL_TIME_FILTER); setCs(""); setCe(""); setImportantOnly(false); }}
            className="text-xs font-semibold text-muted-foreground hover:text-foreground underline">
            Clear filters
          </button>
        )}
      </div>

      {crmMissing && !showEstimates && (
        <div className="text-xs text-muted-foreground bg-secondary/50 border border-border rounded-lg px-3 py-2 flex items-center gap-2">
          <Database className="w-3.5 h-3.5 shrink-0" />
          No JobProgress data synced yet, so cards show debrief-app fields only and the CRM rule cannot exclude No Sees or cancellations.
        </div>
      )}

      {showEstimates ? (
        estimatesInProgress.length === 0 ? (
          <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground">
            <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-40" />
            No estimates in progress.
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-bold text-accent uppercase tracking-wide">Estimates in Progress</span>
              <span className="text-xs font-semibold bg-accent/15 text-accent px-2 py-0.5 rounded-full">{estimatesInProgress.length}</span>
            </div>
            <div className="space-y-2">
              {estimatesInProgress.map((d) => (
                <div key={d.id} className="bg-white rounded-xl border border-border p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <div className="min-w-0">
                      <div className="font-bold text-primary truncate">{d.customer_name}</div>
                      <div className="text-xs text-muted-foreground">{usDate(d.appointment_date) || "No date"}</div>
                    </div>
                    <button
                      onClick={() => markEstimateSent(d)}
                      disabled={markingId === d.id}
                      className="shrink-0 bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-semibold text-sm px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors">
                      {markingId === d.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                      Mark Estimate Sent
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <Info label="Address" value={d.address || "—"} />
                    <Info label="City" value={d.city || "—"} />
                    <Info label="Sales Rep" value={d.sales_rep || "—"} />
                    <Info label="Division" value={d.product || "—"} />
                    <Info label="Days Open" value={daysOpen(d.appointment_date)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      ) : loading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : queue.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground">
          <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-40" />
          {importantOnly ? "Nothing important outstanding in this range." : "All caught up — no items in this view."}
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map((item) => <QueueCard key={item.a.id} item={item} />)}
        </div>
      )}
    </div>
  );
}

/* ── Card ── */

const RESULT_STYLE = {
  sale: "bg-green-100 text-green-800", demo: "bg-amber-100 text-amber-800", no_demo: "bg-slate-100 text-slate-700",
  no_see: "bg-red-100 text-red-700", cancelled: "bg-red-100 text-red-700", awaiting: "bg-sky-100 text-sky-700",
  no_result: "bg-orange-100 text-orange-800", upcoming: "bg-slate-100 text-slate-600",
};
const TWO_LEG_LABEL = { two_leg: "2-Leg", one_leg: "1-Leg", other: "Legs: other" };

function money(v) { return "$" + Math.round(Number(v) || 0).toLocaleString(); }
function ago(days) {
  if (days == null) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function crmResultBadge(crm) {
  if (!crm) return null;
  if (crm.status === "run") {
    const kind = crm.isSale ? "sale" : crm.isDemo ? "demo" : "no_demo";
    return { text: `CRM: ${crm.result}`, cls: RESULT_STYLE[kind] };
  }
  return { text: `CRM: ${CRM_STATUS_LABELS[crm.status] ?? crm.status}`, cls: RESULT_STYLE[crm.status] ?? RESULT_STYLE.no_demo };
}

function QueueCard({ item }) {
  const { a, crm, lead, job, daysSince, debriefed, disposition } = item;
  const result = crmResultBadge(crm);
  const missing = disposition === "missing";
  const jobType = crm?.jobType && crm.jobType !== "Unassigned" ? crm.jobType : null;
  const rep = a.original_sales_rep || crm?.salesRep;
  const setter = a.original_appointment_setter || crm?.setter;

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="min-w-0">
          <div className="font-bold text-primary truncate">{a.customer_name}</div>
          <div className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2">
            <span>{usDate(a.appointment_date) || "No date"}{a.appointment_time ? ` • ${simpleTime(a.appointment_time)}` : ""}</span>
            {ago(daysSince) && <span className={isImportant(item) ? "text-red-600 font-semibold" : ""}>{ago(daysSince)}</span>}
            {crm?.title && !crm.title.toLowerCase().startsWith(String(a.customer_name || "").toLowerCase()) && (
              <span className="truncate max-w-[16rem]" title={crm.title}>{crm.title}</span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <Link to={`/submit?appointment_id=${a.id}`}
            className="bg-accent hover:bg-accent/90 text-white font-semibold text-sm px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors">
            <Plus className="w-4 h-4" /> Debrief
          </Link>
          {crm?.jpUrl && (
            <a href={crm.jpUrl} target="_blank" rel="noopener noreferrer"
              className="text-[11px] font-semibold text-sky-700 hover:underline flex items-center gap-1">
              Open in JobProgress <ExternalLink className="w-3 h-3" />
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-x-3 gap-y-1 text-xs">
        <Info label="Address" value={a.address || "—"} />
        <Info label="City" value={a.city || "—"} />
        <Info label="Job Type" value={jobType || a.product || "—"} />
        <Info label="Sales Rep" value={rep || "—"} />
        <Info label="Setter" value={setter || "—"} />
        <Info label="Job #" value={a.crm_lead_id || job?.jobNumber || "—"} />
        {a.phone && <Info label="Phone" value={<a href={`tel:${a.phone}`} className="text-sky-700 hover:underline inline-flex items-center gap-1"><Phone className="w-3 h-3" />{a.phone}</a>} />}
        {a.email && <Info label="Email" value={<a href={`mailto:${a.email}`} className="text-sky-700 hover:underline inline-flex items-center gap-1"><Mail className="w-3 h-3" />{a.email}</a>} />}
        {lead && <Info label="Lead Source" value={lead.kind === "unknown" ? "—" : lead.source} />}
        {lead?.callCenterRep && <Info label="Call Center Rep" value={lead.callCenterRep} />}
        {crm?.bookedAt && <Info label="Booked" value={`${usDate(crm.bookedAt)}${crm.setter ? ` by ${crm.setter}` : ""}`} />}
        {job?.stage && <Info label="CRM Stage" value={job.stage} />}
        {job?.signedDate && <Info label="Signed" value={`${usDate(job.signedDate)}${job.price ? ` • ${money(job.price)}` : ""}`} />}
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-2">
        {(isInsuranceAppointment(a) || crm?.isInsurance) && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">Insurance</span>
        )}
        {crm?.isReset && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Reset</span>}
        {crm?.isRehash && <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Rehash</span>}
        {result && (
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${result.cls}`} title={crm.twoLegRaw ? `Two-Leg answer: ${crm.twoLegRaw}` : undefined}>
            {result.text}
          </span>
        )}
        {crm?.twoLeg && (
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-teal-100 text-teal-800" title={crm.twoLegRaw || undefined}>{TWO_LEG_LABEL[crm.twoLeg]}</span>
        )}
        {!crm && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-secondary text-muted-foreground" title="No matching appointment in the JobProgress mirror for this Lead ID and date.">Not in CRM mirror</span>}
        <Badge text={a.appointment_status || "Set"} />
        <Badge text={debriefed ? "Submitted" : (a.debrief_status || "Missing")} highlight={missing} />
      </div>
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium text-foreground break-words">{value}</span>
    </div>
  );
}

function Badge({ text, highlight }) {
  return (
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
      highlight ? "bg-accent/15 text-accent" : "bg-secondary text-muted-foreground"
    }`}>
      {text}
    </span>
  );
}
