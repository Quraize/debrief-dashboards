import { MARKETING_CATEGORIES } from "@allied/shared/marketingSources";
import { describeFilters, activeFilterCount, EMPTY_DEBRIEF_FILTERS } from "@allied/shared/debriefFilters";
import { X } from "lucide-react";

/**
 * The debrief-side filter bar: rep, setter, appointment type, marketing
 * category + source, trade.
 *
 * It filters the REP-SUBMITTED section only. The CRM section below reads
 * JobProgress directly and is deliberately left alone, so the bar says so
 * whenever a filter is on — otherwise the two sections look like they
 * disagree when they are simply answering different questions.
 *
 * @param {{ value: object, onChange: (next: object) => void,
 *           options: { reps: string[], setters: string[], apptTypes: string[], sources: string[], trades: string[] },
 *           count: number }} props
 */
export default function DebriefFilterBar({ value, onChange, options, count }) {
  const set = (k, v) => onChange({ ...value, [k]: v });
  const active = describeFilters(value);
  const n = activeFilterCount(value);

  return (
    <div className="bg-white rounded-xl border border-border p-3 shadow-sm space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Field label="Sales Rep">
          <Picker value={value.rep} onChange={(v) => set("rep", v)} all="All Reps" options={options.reps} />
        </Field>
        <Field label="Appointment Setter">
          <Picker value={value.setter} onChange={(v) => set("setter", v)} all="All Setters" options={options.setters} />
        </Field>
        <Field label="Appointment Type">
          <Picker value={value.apptType} onChange={(v) => set("apptType", v)} all="All Types" options={options.apptTypes} />
        </Field>
        <Field label="Marketing Category">
          <Picker value={value.mktCategory} onChange={(v) => set("mktCategory", v)} all="All Categories" options={MARKETING_CATEGORIES} />
        </Field>
        <Field label="Marketing Source">
          <Picker value={value.source} onChange={(v) => set("source", v)} all="All Sources" options={options.sources} />
        </Field>
        <Field label="Trade">
          <Picker value={value.trade} onChange={(v) => set("trade", v)} all="All Trades" options={options.trades} />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">
          {count} debrief{count === 1 ? "" : "s"} in range{n > 0 ? " after filters" : ""}
        </span>
        {active.map((f) => (
          <button key={f.key} onClick={() => set(f.key, "")} title={`Remove the ${f.label} filter`}
            className="inline-flex items-center gap-1 bg-accent/10 text-accent font-semibold px-2 py-0.5 rounded-full">
            <span className="text-muted-foreground font-normal">{f.label}:</span> {f.value}
            <X className="w-3 h-3" />
          </button>
        ))}
        {n > 0 && (
          <>
            <button onClick={() => onChange({ ...EMPTY_DEBRIEF_FILTERS })}
              className="font-semibold text-muted-foreground hover:text-foreground underline">Clear filters</button>
            <span className="basis-full text-muted-foreground">
              These filters apply to the rep-submitted section only. The JobProgress (CRM) section below is unfiltered.
            </span>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">{label}</span>
      {children}
    </label>
  );
}

function Picker({ value, onChange, all, options }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      className="w-full border border-input rounded-lg px-2 py-2 text-sm font-medium bg-white">
      <option value="">{all}</option>
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
