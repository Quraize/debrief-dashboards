import { useState } from "react";
import { base44 } from "@/api/client";
import { useQueryClient } from "@tanstack/react-query";
import { Trash2, Loader2, AlertTriangle, X } from "lucide-react";
import { isValidId } from "@allied/shared/appointmentMatching";

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());

export default function MoveToTrashModal({ appointment, debriefs, onClose, onDeleted, toast }) {
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();

  // Find linked debriefs
  const linkedDebriefs = (debriefs || []).filter((d) => {
    if (d.appointment_id && d.appointment_id === appointment.id) return true;
    if (d.appointment_record_id && appointment.appointment_record_id &&
        norm(d.appointment_record_id) === norm(appointment.appointment_record_id)) return true;
    if (d.crm_lead_id && appointment.crm_lead_id && d.appointment_date && appointment.appointment_date &&
        norm(d.crm_lead_id) === norm(appointment.crm_lead_id) && d.appointment_date === appointment.appointment_date) return true;
    return false;
  });

  async function doDelete(includeDebriefs) {
    if (!isValidId(appointment.id)) {
      toast({ title: "Cannot delete", description: "Appointment has no valid internal id.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      await base44.entities.Appointment.delete(appointment.id);
      if (includeDebriefs) {
        for (const d of linkedDebriefs) {
          if (isValidId(d.id)) {
            await base44.entities.Debrief.delete(d.id);
          }
        }
      }
      qc.invalidateQueries({ queryKey: ["appointments-all"] });
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      qc.invalidateQueries({ queryKey: ["debriefs-all"] });
      toast({ title: "Moved to Trash", description: includeDebriefs
        ? `Appointment and ${linkedDebriefs.length} linked debrief(s) moved to recoverable Trash.`
        : "Appointment moved to recoverable Trash." });
      onDeleted();
    } catch (err) {
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md max-h-[90vh] overflow-y-auto p-5 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="font-heading font-bold text-lg text-primary flex items-center gap-2">
            <Trash2 className="w-5 h-5 text-red-600" /> Move to Trash
          </h2>
          <button onClick={onClose}><X className="w-5 h-5" /></button>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-lg p-3 space-y-1.5 text-sm">
          <div className="font-bold text-primary">{appointment.customer_name || "(unnamed)"}</div>
          <div className="text-xs text-muted-foreground">Date/Time: {appointment.appointment_date || "—"} {appointment.appointment_time || ""}</div>
          <div className="text-xs text-muted-foreground">Title: {appointment.title || "—"}</div>
          <div className="text-xs text-muted-foreground">CRM Lead ID: {appointment.crm_lead_id || "—"}</div>
        </div>

        {linkedDebriefs.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-sm">
                <div className="font-semibold text-amber-800">{linkedDebriefs.length} linked Debrief(s) found</div>
                <div className="text-xs text-amber-700 mt-0.5">
                  {linkedDebriefs.map((d) => d.customer_name).join(", ")}
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              This appointment has linked debrief records. Choose how to handle them:
            </p>
            <div className="space-y-2">
              <button onClick={() => doDelete(true)} disabled={busy}
                className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                Move Appointment + {linkedDebriefs.length} Debrief(s) to Trash
              </button>
              <button onClick={onClose} disabled={busy}
                className="w-full bg-secondary hover:bg-secondary/80 disabled:opacity-50 text-secondary-foreground font-bold py-3 rounded-lg">
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">No linked debriefs. This will move the appointment to recoverable Trash.</p>
            <button onClick={() => doDelete(false)} disabled={busy}
              className="w-full bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Move to Trash
            </button>
            <button onClick={onClose} disabled={busy}
              className="w-full bg-secondary hover:bg-secondary/80 disabled:opacity-50 text-secondary-foreground font-bold py-3 rounded-lg">
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}