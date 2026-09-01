import { useQuery } from "@tanstack/react-query";
import { base44 } from "@/api/client";

const selectCls = "w-full border border-input rounded-lg px-3 py-3 text-base font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white";

// Submitted By is derived from active sales_rep + active appointment_setter ListOptions,
// plus "Allied AI Partners" and "Other". Inactive/historical aliases (Pete, Ashley,
// Sebastian, Mario, etc.) are excluded from normal new-debrief selection.
export default function SubmittedBySelect({ value, onChange, placeholder = "Select…" }) {
  const { data: reps = [] } = useQuery({
    queryKey: ["list-options", "sales_rep"],
    queryFn: () => base44.entities.ListOption.filter({ category: "sales_rep" })
  });
  const { data: setters = [] } = useQuery({
    queryKey: ["list-options", "appointment_setter"],
    queryFn: () => base44.entities.ListOption.filter({ category: "appointment_setter" })
  });

  const activeValues = (arr) => arr.filter((o) => o.active !== false).map((o) => o.value);
  const names = [];
  const seen = new Set();
  ["Allied AI Partners", ...activeValues(reps), ...activeValues(setters), "Other"].forEach((n) => {
    if (!seen.has(n)) { seen.add(n); names.push(n); }
  });
  // Preserve a historical/prefilled value that isn't in the active list (read-only fallback).
  const showFallback = value && !names.includes(value);

  return (
    <select className={selectCls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {showFallback && <option value={value}>{value}</option>}
      {names.map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  );
}