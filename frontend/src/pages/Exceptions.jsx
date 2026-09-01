import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { dataQualityFlags } from "@allied/shared/kpi";
import PartialWriteAudit from "@/components/PartialWriteAudit";
import { AlertTriangle, Loader2 } from "lucide-react";

export default function Exceptions() {
  const { data: debriefs = [], isLoading } = useQuery({ queryKey: ["debriefs"], queryFn: () => base44.entities.Debrief.list("-created_date", 500) });
  const { data: appointments = [] } = useQuery({ queryKey: ["appointments-all"], queryFn: () => base44.entities.Appointment.list("-created_date", 500) });

  const flagged = debriefs
    .map((d) => ({ ...d, flags: dataQualityFlags(d) }))
    .filter((d) => d.flags.length > 0);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Exceptions / Unmatched Records</h1>
        <p className="text-sm text-muted-foreground">Records needing review before export.</p>
      </div>

      <PartialWriteAudit />

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : flagged.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-8 text-center text-muted-foreground">
          <AlertTriangle className="w-10 h-10 mx-auto mb-2 text-green-500" />
          No exceptions — all records are clean.
        </div>
      ) : (
        <div className="space-y-2">
          {flagged.map((d) => (
            <div key={d.id} className="bg-white rounded-xl border border-border p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-bold text-primary">{d.customer_name}</div>
                  <div className="text-xs text-muted-foreground">{d.appointment_date} • {d.sales_rep} • {d.appointment_outcome}</div>
                </div>
                <span className="text-xs font-semibold bg-accent/15 text-accent px-2 py-1 rounded-full shrink-0">{d.flags.length} flag{d.flags.length > 1 ? "s" : ""}</span>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {d.flags.map((f) => (
                  <span key={f} className="text-xs bg-red-50 text-red-700 border border-red-200 px-2 py-1 rounded-full">{f}</span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}