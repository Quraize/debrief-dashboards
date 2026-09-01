import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { Search, Loader2, Plus, X, Pencil, Trash2, Copy, Info } from "lucide-react";
import { PRODUCTS, APPOINTMENT_STATUSES, DEBRIEF_STATUSES } from "@allied/shared/constants";
import { isValidId } from "@allied/shared/appointmentMatching";
import { canonicalAppointmentKey } from "@allied/shared/salesAppointment";
import MoveToTrashModal from "@/components/MoveToTrashModal";
import MarkDuplicateModal from "@/components/MarkDuplicateModal";

const VIEW_FILTERS = ["All", "Sales Only", "Non-Sales", "Possible Duplicates"];

export default function AppointmentRecords() {
  const [q, setQ] = useState("");
  const [viewFilter, setViewFilter] = useState("All");
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [trashTarget, setTrashTarget] = useState(null);
  const [dupTarget, setDupTarget] = useState(null);
  const [showTrashInfo, setShowTrashInfo] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const isManager = me && (me.role === "admin" || me.role === "sales_manager");

  const { data: appointments = [], isLoading } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-created_date", 500)
  });
  const { data: debriefs = [] } = useQuery({
    queryKey: ["debriefs-all"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });

  // Detect possible duplicates: appointments sharing the same canonical key
  const dupKeys = useMemo(() => {
    const map = {};
    appointments.forEach((a) => {
      if (!a.crm_lead_id || !a.appointment_date) return;
      const key = canonicalAppointmentKey(a.crm_lead_id, a.appointment_date, a.appointment_time);
      map[key] = (map[key] || 0) + 1;
    });
    return new Set(Object.entries(map).filter(([, count]) => count > 1).map(([key]) => key));
  }, [appointments]);

  const isPossibleDup = (a) => {
    if (!a.crm_lead_id || !a.appointment_date) return false;
    return dupKeys.has(canonicalAppointmentKey(a.crm_lead_id, a.appointment_date, a.appointment_time));
  };

  const filtered = useMemo(() => {
    let result = appointments;
    if (viewFilter === "Sales Only") result = result.filter((a) => a.is_sales_appointment !== false);
    else if (viewFilter === "Non-Sales") result = result.filter((a) => a.is_sales_appointment === false);
    else if (viewFilter === "Possible Duplicates") result = result.filter(isPossibleDup);
    if (q) {
      const s = q.toLowerCase();
      result = result.filter((a) =>
        [a.customer_name, a.contact_name, a.phone, a.crm_lead_id, a.city, a.original_sales_rep, a.marketing_source, a.title]
          .some((v) => v && v.toLowerCase().includes(s))
      );
    }
    return result;
  }, [appointments, q, viewFilter, dupKeys]);

  const salesCount = appointments.filter((a) => a.is_sales_appointment !== false).length;
  const nonSalesCount = appointments.filter((a) => a.is_sales_appointment === false).length;
  const dupCount = appointments.filter(isPossibleDup).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Appointment Records</h1>
          <p className="text-sm text-muted-foreground">{appointments.length} total • {salesCount} sales • {nonSalesCount} non-sales • {dupCount} possible duplicates</p>
        </div>
        <button onClick={() => setCreating(true)} className="bg-accent hover:bg-accent/90 text-white font-semibold text-sm px-4 py-2.5 rounded-lg flex items-center gap-1.5">
          <Plus className="w-4 h-4" /> New
        </button>
      </div>

      {/* View filters */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1">
        {VIEW_FILTERS.map((f) => (
          <button key={f} onClick={() => setViewFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-colors ${
              viewFilter === f ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {f}
          </button>
        ))}
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search customer, contact, phone, title, rep, source…"
          className="w-full border border-input rounded-lg pl-10 pr-3 py-3 text-sm font-medium bg-white" />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground text-sm">No appointments found.</div>
      ) : (
        <div className="space-y-2">
          {filtered.map((a) => {
            const isNonSales = a.is_sales_appointment === false;
            const isDup = isPossibleDup(a);
            return (
              <div key={a.id} className="bg-white rounded-xl border border-border p-4 shadow-sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-bold text-primary">{a.customer_name}</span>
                      {a.contact_name && <span className="text-xs text-muted-foreground">/ {a.contact_name}</span>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {a.appointment_date || "No appt date"} {a.appointment_time ? `• ${a.appointment_time}` : ""} • {a.product || "—"} • {a.city || ""}
                    </div>
                    {a.title && <div className="text-xs text-muted-foreground">Title: {a.title}</div>}
                    {a.crm_lead_id && <div className="text-xs text-muted-foreground">CRM: {a.crm_lead_id}</div>}
                    {isNonSales && a.exclusion_reason && (
                      <div className="text-xs text-red-600 font-medium mt-0.5">{a.exclusion_reason}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    <div className="flex gap-1 flex-wrap justify-end">
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                        isNonSales ? "bg-slate-200 text-slate-700" : "bg-green-100 text-green-700"
                      }`}>
                        {isNonSales ? "Non-Sales" : "Sales"}
                      </span>
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${statusColor(a.appointment_status)}`}>{a.appointment_status || "Set"}</span>
                      <span className={`text-xs font-semibold px-2 py-1 rounded-full ${debriefColor(a.debrief_status)}`}>{a.debrief_status || "Missing"}</span>
                      {isDup && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Possible Dup</span>}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <button onClick={() => setEditing(a)} className="text-xs text-accent font-semibold flex items-center gap-1"><Pencil className="w-3 h-3" /> Edit</button>
                      {isManager && (
                        <>
                          <button onClick={() => setTrashTarget(a)} className="text-xs text-red-600 font-semibold flex items-center gap-1"><Trash2 className="w-3 h-3" /> Trash</button>
                          {isDup && (
                            <button onClick={() => setDupTarget(a)} className="text-xs text-amber-600 font-semibold flex items-center gap-1"><Copy className="w-3 h-3" /> Mark Dup</button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recoverable Trash info */}
      {isManager && (
        <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
          <button onClick={() => setShowTrashInfo(!showTrashInfo)} className="flex items-center gap-2 text-sm font-semibold text-primary w-full text-left">
            <Info className="w-4 h-4 text-muted-foreground" />
            Recoverable Trash
          </button>
          {showTrashInfo && (
            <div className="mt-2 text-xs text-muted-foreground space-y-1">
              <p>Deleted appointments are moved to recoverable Trash (not permanently erased). To restore a deleted record, use the Base44 dashboard Trash view for this app's Appointment entity.</p>
              <p>Linked debriefs moved to Trash together with an appointment can also be restored from the Debrief entity Trash view.</p>
            </div>
          )}
        </div>
      )}

      {(editing || creating) && (
        <AppointmentModal
          appointment={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { qc.invalidateQueries({ queryKey: ["appointments-all"] }); setEditing(null); setCreating(false); }}
          toast={toast}
        />
      )}

      {trashTarget && (
        <MoveToTrashModal
          appointment={trashTarget}
          debriefs={debriefs}
          onClose={() => setTrashTarget(null)}
          onDeleted={() => { setTrashTarget(null); qc.invalidateQueries({ queryKey: ["appointments-all"] }); }}
          toast={toast}
        />
      )}

      {dupTarget && (
        <MarkDuplicateModal
          appointment={dupTarget}
          appointments={appointments}
          debriefs={debriefs}
          onClose={() => setDupTarget(null)}
          onResolved={() => setDupTarget(null)}
          toast={toast}
        />
      )}
    </div>
  );
}

function statusColor(s) {
  switch (s) {
    case "Completed": return "bg-green-100 text-green-700";
    case "Cancelled": case "No Show": return "bg-red-100 text-red-700";
    case "Rescheduled": return "bg-amber-100 text-amber-700";
    case "Duplicate": return "bg-purple-100 text-purple-700";
    default: return "bg-secondary text-secondary-foreground";
  }
}
function debriefColor(s) {
  switch (s) {
    case "Submitted": return "bg-blue-100 text-blue-700";
    case "Approved": return "bg-green-100 text-green-700";
    case "Needs Review": case "Unmatched": return "bg-amber-100 text-amber-700";
    default: return "bg-red-100 text-red-700";
  }
}

function AppointmentModal({ appointment, onClose, onSaved, toast }) {
  const [form, setForm] = useState(appointment || {
    customer_name: "", contact_name: "", phone: "", crm_lead_id: "", appointment_date: "", appointment_time: "",
    title: "", product: "", appointment_status: "Set", debrief_status: "Missing", city: "", marketing_source: "",
    original_sales_rep: "", original_appointment_setter: "", is_sales_appointment: true, exclusion_reason: "", notes: ""
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true);
    try {
      if (appointment && isValidId(appointment.id)) {
        await base44.entities.Appointment.update(appointment.id, form);
        toast({ title: "Appointment updated" });
      } else if (appointment && !isValidId(appointment.id)) {
        toast({ title: "Cannot update", description: "Appointment has no valid internal id.", variant: "destructive" });
      } else {
        await base44.entities.Appointment.create(form);
        toast({ title: "Appointment created" });
      }
      onSaved();
    } catch (err) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-lg text-primary">{appointment ? "Edit Appointment" : "New Appointment"}</h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>
        <In label="Customer / Job Name" value={form.customer_name} onChange={(v) => set("customer_name", v)} />
        <In label="Contact Name" value={form.contact_name} onChange={(v) => set("contact_name", v)} />
        <div className="grid grid-cols-2 gap-2">
          <In label="Phone" value={form.phone} onChange={(v) => set("phone", v)} />
          <In label="City" value={form.city} onChange={(v) => set("city", v)} />
        </div>
        <In label="Appointment Title" value={form.title} onChange={(v) => set("title", v)} />
        <In label="CRM Lead ID" value={form.crm_lead_id} onChange={(v) => set("crm_lead_id", v)} />
        <div className="grid grid-cols-2 gap-2">
          <In label="Appointment Date" type="date" value={form.appointment_date} onChange={(v) => set("appointment_date", v)} />
          <In label="Time" value={form.appointment_time} onChange={(v) => set("appointment_time", v)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Sel label="Division" value={form.product} onChange={(v) => set("product", v)} options={PRODUCTS} />
          <Sel label="Appt Status" value={form.appointment_status} onChange={(v) => set("appointment_status", v)} options={APPOINTMENT_STATUSES} />
        </div>
        <Sel label="Debrief Status" value={form.debrief_status} onChange={(v) => set("debrief_status", v)} options={DEBRIEF_STATUSES} />
        <div className="grid grid-cols-2 gap-2">
          <In label="Sales Rep" value={form.original_sales_rep} onChange={(v) => set("original_sales_rep", v)} />
          <In label="Setter" value={form.original_appointment_setter} onChange={(v) => set("original_appointment_setter", v)} />
        </div>
        <In label="Marketing Source" value={form.marketing_source} onChange={(v) => set("marketing_source", v)} />
        <div className="grid grid-cols-2 gap-2">
          <label className="block space-y-1">
            <span className="text-xs font-semibold text-foreground">Sales Appointment?</span>
            <select className={cls} value={form.is_sales_appointment === false ? "false" : "true"} onChange={(e) => set("is_sales_appointment", e.target.value === "true")}>
              <option value="true">Yes (Sales)</option>
              <option value="false">No (Non-Sales)</option>
            </select>
          </label>
          <In label="Exclusion Reason" value={form.exclusion_reason} onChange={(v) => set("exclusion_reason", v)} />
        </div>
        <In label="Notes" value={form.notes} onChange={(v) => set("notes", v)} textarea />
        <button onClick={save} disabled={saving || !form.customer_name}
          className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-bold py-3 rounded-lg">
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

const cls = "w-full border border-input rounded-lg px-3 py-2.5 text-sm font-medium bg-white";
function In({ label, value, onChange, type = "text", textarea }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      {textarea ? <textarea className={cls + " min-h-20"} value={value} onChange={(e) => onChange(e.target.value)} /> :
        <input type={type} className={cls} value={value || ""} onChange={(e) => onChange(e.target.value)} />}
    </label>
  );
}
function Sel({ label, value, onChange, options }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-foreground">{label}</span>
      <select className={cls} value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">Select…</option>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}