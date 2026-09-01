export default function ClassificationCounts({ counts }) {
  const items = [
    { label: "Roofing", value: counts.roofing, cls: "text-green-700 bg-green-50 border-green-200" },
    { label: "Siding", value: counts.siding, cls: "text-green-700 bg-green-50 border-green-200" },
    { label: "Roofing + Siding", value: counts.roofingSiding, cls: "text-green-700 bg-green-50 border-green-200" },
    { label: "Commercial", value: counts.commercial, cls: "text-blue-700 bg-blue-50 border-blue-200" },
    { label: "Repairs", value: counts.repairs, cls: "text-amber-700 bg-amber-50 border-amber-200" },
    { label: "Misc", value: counts.misc, cls: "text-amber-700 bg-amber-50 border-amber-200" },
    { label: "Insurance", value: counts.insurance, cls: "text-indigo-700 bg-indigo-50 border-indigo-200" },
    { label: "Non-Sales", value: counts.nonSales, cls: "text-slate-700 bg-slate-100 border-slate-300" },
    { label: "Unclassified", value: counts.unclassified, cls: "text-red-700 bg-red-50 border-red-200" },
    { label: "Conflicts", value: counts.conflicts, cls: "text-orange-700 bg-orange-50 border-orange-200" },
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((it) => (
        <div key={it.label} className={`rounded-lg border px-2.5 py-1 text-xs font-semibold ${it.cls}`}>
          {it.label}: <span className="font-bold">{it.value}</span>
        </div>
      ))}
    </div>
  );
}