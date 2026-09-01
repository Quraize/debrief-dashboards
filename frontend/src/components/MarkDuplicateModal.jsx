import { useState } from "react";
import { base44 } from "@/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Loader2, X, Check } from "lucide-react";
import { isValidId } from "@allied/shared/appointmentMatching";
import { canonicalAppointmentKey } from "@allied/shared/salesAppointment";

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());

export default function MarkDuplicateModal({ appointment, appointments, debriefs, onClose, onResolved, toast }) {
  const [keepId, setKeepId] = useState(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  // Find likely canonical matches: same CRM Lead ID + date + time
  const key = canonicalAppointmentKey(appointment.crm_lead_id, appointment.appointment_date, appointment.appointment_time);
  const matches = (appointments || []).filter((a) =>
    a.id !== appointment.id &&
    canonicalAppointmentKey(a.crm_lead_id, a.appointment_date, a.appointment_time) === key
  );

  // Include the current appointment in the selection list
  const candidates = [appointment, ...matches];

  function linkedDebriefCount(a) {
    return (debriefs || []).filter((d) => {
      if (d.appointment_id && d.appointment_id === a.id) return true;
      if (d.appointment_record_id && a.appointment_record_id &&
          norm(d.appointment_record_id) === norm(a.appointment_record_id)) return true;
      if (d.crm_lead_id && a.crm_lead_id && d.appointment_date && a.appointment_date &&
          norm(d.crm_lead_id) === norm(a.crm_lead_id) && d.appointment_date === a.appointment_date) return true;
      return false;
    }).length;
  }

  async function doResolve() {
    if (!keepId) {
      toast({ title: "Select a record to keep", variant: "destructive" });
      return;
    }
    const toDelete = candidates.find((c) => c.id === keepId);
    if (!toDelete) return;
    // The record(s) NOT selected are moved to Trash
    const dups = candidates.filter((c) => c.id !== keepId);
    if (dups.length === 0) {
      onClose();
      return;
    }
    setBusy(true);
    try {
      for (const dup of dups) {
        if (isValidId(dup.id)) {
          await base44.entities.Appointment.update(dup.id, { appointment_status: "Duplicate" });
          await base44.entities.Appointment.delete(dup.id);
        }
      }
      qc.invalidateQueries({ queryKey: ["appointments-all"] });
      toast({ title: "Duplicate resolved", description: `${dups.length} record(s) moved to Trash. Kept: ${toDelete.customer_name}.` });
      onResolved();
    } catch (err) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  if (matches.length === 0) {
    return (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />
        <div className="relative bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-heading font-bold text-lg text-primary">Mark Duplicate</h2>
            <button onClick={onClose}><X className="w-5 h-5" /></button>
          </div>
          <p className="text-sm text-muted-foreground">No likely duplicates found for this appointment (same CRM Lead ID + date + time).</p>
          <button onClick={onClose} className="w-full bg-secondary font-bold py-3 rounded-lg">Close</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[90vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-lg text-primary flex items-center gap-2">
            <Copy className="w-5 h-5 text-amber-600" /> Mark Duplicate
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <p className="text-sm text-muted-foreground">
          {matches.length + 1} records share the same CRM Lead ID + date + time. Select which record to <strong>keep</strong>. The others will be moved to recoverable Trash.
        </p>

        <div className="space-y-2">
          {candidates.map((c) => {
            const isSelected = keepId === c.id;
            const debriefCount = linkedDebriefCount(c);
            return (
              <button key={c.id} onClick={() => setKeepId(c.id)}
                className={`w-full text-left border-2 rounded-lg p-3 transition-colors ${
                  isSelected ? "border-green-500 bg-green-50" : "border-border bg-white hover:bg-secondary/30"
                }`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-bold text-primary text-sm">{c.customer_name || "(unnamed)"}</div>
                    <div className="text-xs text-muted-foreground">
                      {c.appointment_date || "—"} {c.appointment_time || ""} • {c.title || "—"}
                    </div>
                    <div className="text-xs text-muted-foreground">CRM: {c.crm_lead_id || "—"}</div>
                    {debriefCount > 0 && (
                      <div className="text-xs text-amber-600 font-semibold mt-0.5">{debriefCount} linked debrief(s)</div>
                    )}
                  </div>
                  {isSelected && <Check className="w-5 h-5 text-green-600 shrink-0" />}
                </div>
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          <button onClick={doResolve} disabled={busy || !keepId}
            className="w-full bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Copy className="w-4 h-4" />}
            Move Duplicate(s) to Trash
          </button>
          <button onClick={onClose} disabled={busy}
            className="w-full bg-secondary hover:bg-secondary/80 disabled:opacity-50 text-secondary-foreground font-bold py-3 rounded-lg">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}