/**
 * Revenue & AR headline totals for the production pages: started this week
 * and month to date, expected cash this week, AR and overdue AR. The detail
 * lives on /production/revenue; this is the glance.
 */
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { productionApi } from "./api";

const money = (v) => (v == null ? "—" : "$" + Math.round(Number(v)).toLocaleString());

export default function RevenueHeadline() {
  const { data } = useQuery({ queryKey: ["production-revenue"], queryFn: productionApi.revenue, staleTime: 60_000 });
  const t = data?.totals;
  if (!t) return null;
  const cells = [
    { label: "Started this week", value: money(t.startedThisWeek), cls: "text-primary" },
    { label: "Started month to date", value: money(t.startedMonthToDate), cls: "text-primary" },
    { label: "Expected this week", value: money(t.expectedThisWeek), cls: "text-blue-700" },
    { label: "Total AR", value: money(t.totalAR), cls: t.totalAR > 0 ? "text-amber-700" : "text-green-700" },
    { label: `Overdue (${t.overdueDays}d+)`, value: money(t.overdueAR), cls: t.overdueAR > 0 ? "text-red-700" : "text-green-700" },
  ];
  return (
    <Link to="/production/revenue" className="block bg-white rounded-xl border border-border p-3 shadow-sm hover:shadow-md transition-shadow" title="Open Revenue & AR">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground">Revenue &amp; AR</div>
        {cells.map((c) => (
          <div key={c.label} className="flex items-baseline gap-1.5">
            <span className={`text-lg font-heading font-bold tabular-nums ${c.cls}`}>{c.value}</span>
            <span className="text-xs text-muted-foreground">{c.label}</span>
          </div>
        ))}
        {t.flags.noPayment > 0 && <span className="text-xs font-semibold text-red-700">{t.flags.noPayment} started with no payment recorded</span>}
        <ArrowRight className="w-4 h-4 text-accent ml-auto" />
      </div>
    </Link>
  );
}
