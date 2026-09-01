import { Calendar, CheckCircle, PlusCircle, Ban, Edit3, Minus, DollarSign, AlertTriangle, AlertCircle, Copy, AlertOctagon } from "lucide-react";

const CARDS = [
  { key: "api_appointments", label: "API Appointments", icon: Calendar, compute: (c) => c.api_appointments_unique ?? 0 },
  { key: "matched", label: "Matched Existing", icon: CheckCircle, compute: (c) => (c.matches_by_appt_id ?? 0) + (c.matches_by_job_number_date ?? 0) },
  { key: "proposed_new", label: "Proposed New", icon: PlusCircle, compute: (c) => c.proposed_new_appointments ?? 0 },
  { key: "excluded", label: "Excluded Non-Sales", icon: Ban, compute: (c) => c.excluded_unmatched_candidates ?? 0 },
  { key: "proposed_updates", label: "Proposed Updates", icon: Edit3, compute: (c) => c.proposed_updates ?? 0 },
  { key: "unchanged", label: "Unchanged", icon: Minus, compute: (c) => c.unchanged ?? 0 },
  { key: "signed_sales", label: "Signed Sales", icon: DollarSign, compute: (c) => c.signed_sales_found ?? 0 },
  { key: "revenue", label: "Aggregate Revenue", icon: DollarSign, compute: (c) => c.revenue_total ?? 0, format: "currency" },
  { key: "financial_exceptions", label: "Financial Exceptions", icon: AlertTriangle, compute: (c) => c.financial_summary_errors ?? 0, alert: true },
  { key: "conflicts", label: "Classification Conflicts", icon: AlertCircle, compute: (c) => c.conflicts ?? 0, alert: true },
  { key: "duplicates", label: "Duplicates", icon: Copy, compute: (c) => c.duplicate_candidates ?? 0, alert: true },
  { key: "errors", label: "Errors", icon: AlertOctagon, compute: (c) => c.errors ?? 0, alert: true },
];

function formatVal(v, format) {
  if (format === "currency") return v != null ? `$${Number(v).toLocaleString()}` : "$0";
  return v ?? 0;
}

export default function SyncResultCards({ counts }) {
  if (!counts) return null;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {CARDS.map((card) => {
        const Icon = card.icon;
        const val = card.compute(counts);
        const display = formatVal(val, card.format);
        const isAlert = card.alert && val > 0;
        return (
          <div key={card.key} className={`rounded-xl border p-4 shadow-sm ${isAlert ? "bg-amber-50 border-amber-300" : "bg-white border-border"}`}>
            <div className="flex items-center gap-2 mb-1">
              <Icon className={`w-4 h-4 ${isAlert ? "text-amber-600" : "text-muted-foreground"}`} />
              <span className="text-[11px] uppercase tracking-wide font-semibold text-muted-foreground leading-tight">{card.label}</span>
            </div>
            <div className={`text-xl font-heading font-bold ${isAlert ? "text-amber-700" : "text-primary"}`}>{display}</div>
          </div>
        );
      })}
    </div>
  );
}