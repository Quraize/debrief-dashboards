import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { AlertTriangle, Loader2 } from "lucide-react";

const STATUS_STYLES = {
  open: "bg-amber-100 text-amber-700",
  resolved: "bg-green-100 text-green-700",
  ignored: "bg-secondary text-muted-foreground",
};

export default function SyncExceptionsPanel() {
  const { data: conflicts = [], isLoading } = useQuery({
    queryKey: ["sync-conflicts"],
    queryFn: () => base44.entities.SyncConflict.list("-created_date", 50).catch(() => []),
  });

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <AlertTriangle className="w-4 h-4 text-amber-500" />
        <h2 className="font-heading font-bold text-sm text-primary">Sync Exceptions</h2>
        <span className="text-xs text-muted-foreground">({conflicts.length})</span>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
      ) : conflicts.length === 0 ? (
        <p className="text-sm text-muted-foreground text-center py-4">No exceptions recorded.</p>
      ) : (
        <div className="space-y-2">
          {conflicts.map((c) => (
            <div key={c.id} className="flex items-start justify-between gap-2 py-2 border-b border-border/60 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-foreground capitalize">{(c.category || "").replace(/_/g, " ")}</div>
                <div className="text-xs text-muted-foreground">{c.reason}</div>
              </div>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full whitespace-nowrap capitalize ${STATUS_STYLES[c.resolution_status] || STATUS_STYLES.open}`}>
                {c.resolution_status || "open"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}