import { useState, useMemo } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { ClipboardList, Loader2, Filter, Plus, Send } from "lucide-react";
import { ESTIMATING_IN_PROGRESS_OUTCOME, DEMO_NO_SALE_OUTCOME } from "@allied/shared/constants";
import { salesAppointmentsOnly } from "@allied/shared/salesAppointment";
import { isInsuranceAppointment } from "@allied/shared/insurance";

const FILTERS = ["Today","Yesterday","This Week","Missing Debrief","Needs Review","Estimates in Progress","By Sales Rep","By Appointment Setter"];

export default function OpenDebriefQueue() {
  const [filter, setFilter] = useState("Missing Debrief");
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

  const salesAppts = useMemo(() => salesAppointmentsOnly(appointments), [appointments]);
  const reps = useMemo(() => [...new Set(salesAppts.map((a) => a.original_sales_rep).filter(Boolean))], [salesAppts]);
  const setters = useMemo(() => [...new Set(salesAppts.map((a) => a.original_appointment_setter).filter(Boolean))], [salesAppts]);
  const [rep, setRep] = useState("");
  const [setter, setSetter] = useState("");

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const yesterdayStr = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7));

  // Debriefs that exist, keyed the way the KPI engine matches them (Lead ID +
  // date). The appointment's own debrief_status can lag — imported debriefs
  // never updated it — so the queue cross-checks rather than trusting it.
  const debriefKeys = useMemo(() => {
    const keys = new Set();
    debriefs.forEach((d) => {
      if (d.crm_lead_id && d.appointment_date) {
        keys.add(String(d.crm_lead_id).toLowerCase().trim() + "|" + String(d.appointment_date).slice(0, 10));
      }
    });
    return keys;
  }, [debriefs]);
  const hasDebrief = (a) =>
    a.debrief_status === "Submitted" || a.debrief_status === "Approved" ||
    (a.crm_lead_id && a.appointment_date &&
      debriefKeys.has(String(a.crm_lead_id).toLowerCase().trim() + "|" + String(a.appointment_date).slice(0, 10)));

  const queue = useMemo(() => {
    return salesAppts.filter((a) => {
      const ad = a.appointment_date;
      // A debrief is only "missing" once the appointment has actually happened.
      const isMissing = !hasDebrief(a) && ad && ad <= todayStr
        && (a.debrief_status === "Missing" || a.debrief_status === "Unmatched");
      const needsReview = a.debrief_status === "Needs Review";
      switch (filter) {
        case "Today": return ad === todayStr;
        case "Yesterday": return ad === yesterdayStr;
        case "This Week": return ad && new Date(ad + "T00:00:00") >= weekStart;
        case "Missing Debrief": return isMissing;
        case "Needs Review": return needsReview;
        case "Estimates in Progress": return false;
        case "By Sales Rep": return rep && (a.original_sales_rep === rep || a.rehash_sales_rep === rep);
        case "By Appointment Setter": return setter && (a.original_appointment_setter === setter || a.rehash_appointment_setter === setter);
        default: return true;
      }
    }).sort((a, b) => (b.appointment_date || "").localeCompare(a.appointment_date || ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [salesAppts, debriefKeys, filter, rep, setter, todayStr, yesterdayStr, weekStart]);

  const estimatesInProgress = useMemo(() => {
    return debriefs
      .filter((d) => d.appointment_outcome === ESTIMATING_IN_PROGRESS_OUTCOME)
      .sort((a, b) => (b.appointment_date || "").localeCompare(a.appointment_date || ""));
  }, [debriefs]);

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

  const showEstimates = filter === "Estimates in Progress";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Open Debrief Queue</h1>
        <p className="text-sm text-muted-foreground">
          Appointments that have happened and have no debrief yet.
          {!isLoading && !showEstimates && <> <span className="font-semibold text-foreground">{queue.length}</span> in this view.</>}
        </p>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        <Filter className="w-4 h-4 text-muted-foreground shrink-0" />
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              filter === f ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {f}
          </button>
        ))}
      </div>

      {(filter === "By Sales Rep" || filter === "By Appointment Setter") && (
        <select
          className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white"
          value={filter === "By Sales Rep" ? rep : setter}
          onChange={(e) => filter === "By Sales Rep" ? setRep(e.target.value) : setSetter(e.target.value)}>
          <option value="">Select…</option>
          {(filter === "By Sales Rep" ? reps : setters).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
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
                      <div className="text-xs text-muted-foreground">{d.appointment_date || "No date"}</div>
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
      ) : isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : queue.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground">
          <ClipboardList className="w-10 h-10 mx-auto mb-2 opacity-40" />
          All caught up — no items in this view.
        </div>
      ) : (
        <div className="space-y-2">
          {queue.map((a) => (
            <div key={a.id} className="bg-white rounded-xl border border-border p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3 mb-2">
                <div className="min-w-0">
                  <div className="font-bold text-primary truncate">{a.customer_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {a.appointment_date || "No date"} {a.appointment_time ? `• ${a.appointment_time}` : ""}
                  </div>
                </div>
                <Link to={`/submit?appointment_id=${a.id}`}
                  className="shrink-0 bg-accent hover:bg-accent/90 text-white font-semibold text-sm px-3 py-2 rounded-lg flex items-center gap-1.5 transition-colors">
                  <Plus className="w-4 h-4" /> Debrief
                </Link>
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <Info label="Address" value={a.address || "—"} />
                <Info label="City" value={a.city || "—"} />
                <Info label="Sales Rep" value={a.original_sales_rep || "—"} />
                <Info label="Setter" value={a.original_appointment_setter || "—"} />
                <Info label="Division" value={a.product || "—"} />
              </div>
              <div className="flex items-center gap-2 mt-2">
                {isInsuranceAppointment(a) && (
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700">Insurance</span>
                )}
                <Badge text={a.appointment_status || "Set"} />
                <Badge text={hasDebrief(a) ? "Submitted" : (a.debrief_status || "Missing")}
                  highlight={!hasDebrief(a) && (a.debrief_status === "Missing" || a.debrief_status === "Unmatched")} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-medium text-foreground truncate">{value}</span>
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