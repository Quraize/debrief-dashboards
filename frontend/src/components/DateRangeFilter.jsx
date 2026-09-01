import { DATE_FILTERS, getDateRangeBounds } from "@allied/shared/constants";

/**
 * @param {{ filter: string, setFilter: Function, customStart: string, setCustomStart: Function,
 *           customEnd: string, setCustomEnd: Function, title?: string }} props
 */
export default function DateRangeFilter({ filter, setFilter, customStart, setCustomStart, customEnd, setCustomEnd, title }) {
  const bounds = getDateRangeBounds(filter, customStart, customEnd);
  return (
    <div className="bg-white rounded-xl border border-border p-3 mb-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        {title && <span className="font-heading font-bold text-sm mr-2">{title}</span>}
        <div className="flex flex-wrap gap-1.5 flex-1">
          {DATE_FILTERS.map((f) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                filter === f ? "bg-accent text-white" : "bg-secondary text-secondary-foreground hover:bg-secondary/70"
              }`}>
              {f}
            </button>
          ))}
        </div>
        {filter === "Custom Range" && (
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input type="date" value={customStart || ""} onChange={(e) => setCustomStart(e.target.value)}
              className="text-xs border border-input rounded-md px-2 py-1.5" />
            <span className="text-muted-foreground">–</span>
            <input type="date" value={customEnd || ""} onChange={(e) => setCustomEnd(e.target.value)}
              className="text-xs border border-input rounded-md px-2 py-1.5" />
          </div>
        )}
      </div>
      {bounds && bounds.start && (
        <div className="text-xs text-muted-foreground mt-2">
          {bounds.start}{bounds.end && bounds.end !== bounds.start ? ` – ${bounds.end}` : ""}
        </div>
      )}
    </div>
  );
}