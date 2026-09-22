/**
 * The Sold-Job Pipeline's headline totals, for the production pages: sold,
 * scheduled, unscheduled, and what the crews are expected to produce this
 * week. The detail lives on /production/pipeline; this is the glance.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());

export default function PipelineHeadline() {
  const { data } = useQuery({ queryKey: ["production-pipeline"], queryFn: productionApi.pipeline, staleTime: 60_000 });
  const t = data?.totals;
  if (!t) return null;
  const cells = [
    { label: "Total Sold Pipeline", value: money(t.totalPipeline), cls: "text-primary" },
    { label: "Scheduled", value: money(t.scheduled + t.inProduction), cls: "text-green-700" },
    { label: "Unscheduled", value: money(t.unscheduled), cls: t.unscheduled > 0 ? "text-red-700" : "text-green-700" },
    { label: "Awaiting production", value: t.awaitingProduction, cls: t.awaitingProduction > 0 ? "text-red-700" : "text-green-700" },
    { label: "Expected this week", value: money(t.expectedThisWeek), cls: "text-blue-700" },
    { label: "Expected next week", value: money(t.expectedNextWeek), cls: "text-blue-700" },
  ];
  return (
    <Link to="/production/pipeline" className="block bg-white rounded-xl border border-border p-3 shadow-sm hover:shadow-md transition-shadow" title="Open the Sold-Job Pipeline">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Sold-Job Pipeline</div>
        {cells.map((c) => (
          <div key={c.label} className="flex items-baseline gap-1.5">
            <span className={`text-lg font-heading font-bold tabular-nums ${c.cls}`}>{c.value}</span>
            <span className="text-xs text-muted-foreground">{c.label}</span>
          </div>
        ))}
        {t.noContractValue > 0 && <span className="text-xs font-semibold text-red-700">{t.noContractValue} with no contract value</span>}
        <ArrowRight className="w-4 h-4 text-accent ml-auto" />
      </div>
    </Link>
  );
}
