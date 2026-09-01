import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { resolveAppointmentForDebrief, isValidId } from "@allied/shared/appointmentMatching";
import { Loader2, Wrench, ShieldCheck, AlertTriangle } from "lucide-react";

export default function PartialWriteAudit() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [repairingId, setRepairingId] = useState(null);

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const isAdmin = me?.role === "admin";

  const partials = useMemo(() => {
    return debriefs.map((d) => {
      const res = resolveAppointmentForDebrief(d, appointments);
      const issues = [];
      if (res.status === "matched" && (!d.appointment_id || !isValidId(d.appointment_id))) issues.push("Matched appointment but link (appointment_id) blank");
      if (res.status === "matched" && isValidId(res.appointmentId) && res.appointment.debrief_status === "Missing") issues.push("Appointment still marked Missing");
      if (d.matched === true && (!d.appointment_id || !isValidId(d.appointment_id))) issues.push("matched=true but no appointment_id");
      if (d.matched !== true && isValidId(d.appointment_id)) issues.push("appointment_id set but matched=false");
      return { debrief: d, resolution: res, issues };
    }).filter((x) => x.issues.length > 0);
  }, [debriefs, appointments]);

  async function repair(item) {
    if (item.resolution.status !== "matched" || !isValidId(item.resolution.appointmentId)) {
      toast({ title: "Cannot repair", description: "No single matching appointment resolved.", variant: "destructive" });
      return;
    }
    if (!window.confirm(`Repair "${item.debrief.customer_name}"? This links the debrief to the matched appointment and marks it Submitted. No records will be deleted.`)) return;
    setRepairingId(item.debrief.id);
    try {
      await base44.entities.Debrief.update(item.debrief.id, {
        matched: true,
        appointment_id: item.resolution.appointmentId,
        manager_review_needed: false,
        data_quality_flag: "",
      });
      await base44.entities.Appointment.update(item.resolution.appointmentId, { debrief_status: "Submitted" });
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      qc.invalidateQueries({ queryKey: ["appointments-all"] });
      toast({ title: "Repaired", description: "Debrief linked and appointment marked Submitted." });
    } catch (err) {
      toast({ title: "Repair failed", description: err.message, variant: "destructive" });
    } finally {
      setRepairingId(null);
    }
  }

  if (!isAdmin) return null;

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-accent" />
        <h2 className="font-heading font-bold text-sm text-primary">Partial-Write Audit (Admin, Dry-Run)</h2>
        <span className="text-xs font-semibold bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full">{partials.length} found</span>
      </div>
      <p className="text-xs text-muted-foreground">
        Debriefs that exist but have a missing/inconsistent appointment link, or whose matched Appointment is still marked Missing. Dry-run only — Repair is explicit per record and never deletes.
      </p>

      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : partials.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-green-600 font-semibold"><AlertTriangle className="w-4 h-4" /> No partial writes detected.</div>
      ) : (
        <div className="space-y-2 max-h-72 overflow-y-auto">
          {partials.map((item) => (
            <div key={item.debrief.id} className="border border-border/60 rounded-lg p-3 bg-secondary/20">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold text-sm text-primary truncate">{item.debrief.customer_name || "(unnamed)"}</div>
                  <div className="text-xs text-muted-foreground">{item.debrief.appointment_date || "—"} • {item.debrief.crm_lead_id || "no Lead ID"} • matched={String(item.debrief.matched)}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {item.issues.map((iss) => (
                      <span key={iss} className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">{iss}</span>
                    ))}
                  </div>
                </div>
                <button
                  onClick={() => repair(item)}
                  disabled={item.resolution.status !== "matched" || repairingId === item.debrief.id}
                  className="shrink-0 flex items-center gap-1 text-xs font-semibold bg-accent text-white px-2.5 py-1.5 rounded-lg disabled:opacity-50">
                  {repairingId === item.debrief.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Wrench className="w-3.5 h-3.5" />}
                  Repair
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}