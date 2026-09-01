import { useMemo } from "react";

/**
 * Read-only filter dropdown that builds its option list from the unique nonblank
 * values present in the loaded Debrief records for the given field, sorted
 * alphabetically. No manage/edit affordances — just a plain styled <select>.
 */
export default function FilterSelect({ debriefs, field, value, onChange, placeholder }) {
  const options = useMemo(() => {
    const set = new Set();
    (debriefs || []).forEach((d) => {
      const v = d[field];
      if (v != null && String(v).trim() !== "") set.add(String(v).trim());
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [debriefs, field]);

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full border border-input rounded-lg px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white text-foreground"
    >
      <option value="">{placeholder}</option>
      {options.map((opt) => (
        <option key={opt} value={opt}>{opt}</option>
      ))}
    </select>
  );
}