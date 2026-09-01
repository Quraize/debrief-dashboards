import { useState } from "react";
import FilterSelect from "./FilterSelect";
import DateRangeFilter from "./DateRangeFilter";
import { X, ChevronDown, Filter } from "lucide-react";

const DATE_OPTIONS = ["Today", "Yesterday", "This Week", "Last Week", "This Month", "Last Month", "Custom Range"];

export default function DebriefFilters({
  debriefs,
  filter, setFilter, cs, setCs, ce, setCe,
  clientName, setClientName,
  city, setCity,
  rep, setRep,
  setter, setSetter,
  div, setDiv,
  outcome, setOutcome,
  dm, setDm,
  source, setSource,
  closeType, setCloseType,
  idSearch, setIdSearch,
  repPlaceholder = "All Sales Reps",
  dateTotalCount = 0,
  filteredCount = 0,
}) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const chips = [];
  if (clientName) chips.push({ key: "cn", label: `Client: ${clientName}`, clear: () => setClientName("") });
  if (city) chips.push({ key: "city", label: `City: ${city}`, clear: () => setCity("") });
  if (rep) chips.push({ key: "rep", label: `Rep: ${rep}`, clear: () => setRep("") });
  if (setSetter && setter) chips.push({ key: "setter", label: `Setter: ${setter}`, clear: () => setSetter("") });
  if (div) chips.push({ key: "div", label: `Division: ${div}`, clear: () => setDiv("") });
  if (outcome) chips.push({ key: "outcome", label: `Outcome: ${outcome}`, clear: () => setOutcome("") });
  if (dm) chips.push({ key: "dm", label: `DM: ${dm}`, clear: () => setDm("") });
  if (setSource && source) chips.push({ key: "source", label: `Source: ${source}`, clear: () => setSource("") });
  if (closeType) chips.push({ key: "close", label: `Close: ${closeType}`, clear: () => setCloseType("") });
  if (setIdSearch && idSearch) chips.push({ key: "id", label: `ID/Addr: ${idSearch}`, clear: () => setIdSearch("") });

  const hasNonDateFilters = !!(clientName || city || rep || (setSetter && setter) || div || outcome || dm || (setSource && source) || closeType || (setIdSearch && idSearch));

  const clearAll = () => {
    setClientName(""); setCity(""); setRep(""); setDiv("");
    setOutcome(""); setDm(""); setCloseType("");
    if (setSetter) setSetter("");
    if (setSource) setSource("");
    if (setIdSearch) setIdSearch("");
  };

  return (
    <div className="bg-white rounded-xl border border-border shadow-sm no-print">
      <div className="p-3 sm:p-4">
        <DateRangeFilter filter={filter} setFilter={setFilter} customStart={cs} setCustomStart={setCs} customEnd={ce} setCustomEnd={setCe} />
      </div>

      {/* Mobile toggle */}
      <div className="lg:hidden px-3 sm:px-4">
        <button onClick={() => setMobileOpen(!mobileOpen)} className="flex items-center gap-1.5 text-xs font-semibold text-accent">
          <Filter className="w-3.5 h-3.5" />
          {mobileOpen ? "Hide Filters" : "Filter Debriefs"}
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${mobileOpen ? "rotate-180" : ""}`} />
        </button>
      </div>

      {/* Filter grid - collapsible on mobile, always visible on lg */}
      <div className={`px-3 sm:px-4 pt-2 ${mobileOpen ? "block" : "hidden"} lg:block`}>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <Field label="Client Name">
            <input className="w-full border border-input rounded-lg px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white" placeholder="Search client name…" value={clientName} onChange={(e) => setClientName(e.target.value)} />
          </Field>
          <Field label="City">
            <FilterSelect debriefs={debriefs} field="city" value={city} onChange={setCity} placeholder="All Cities" />
          </Field>
          <Field label="Sales Rep">
            <FilterSelect debriefs={debriefs} field="sales_rep" value={rep} onChange={setRep} placeholder={repPlaceholder} />
          </Field>
          {setSetter && (
            <Field label="Appointment Setter">
              <FilterSelect debriefs={debriefs} field="appointment_setter" value={setter} onChange={setSetter} placeholder="All Setters" />
            </Field>
          )}
          <Field label="Division / Category">
            <FilterSelect debriefs={debriefs} field="product" value={div} onChange={setDiv} placeholder="All Divisions" />
          </Field>
          <Field label="Appointment Outcome">
            <FilterSelect debriefs={debriefs} field="appointment_outcome" value={outcome} onChange={setOutcome} placeholder="All Outcomes" />
          </Field>
          <Field label="Decision Maker Status">
            <FilterSelect debriefs={debriefs} field="decision_maker_status" value={dm} onChange={setDm} placeholder="All DM Status" />
          </Field>
          {setSource && (
            <Field label="Marketing Source">
              <FilterSelect debriefs={debriefs} field="marketing_source" value={source} onChange={setSource} placeholder="All Sources" />
            </Field>
          )}
          <Field label="Sale / Close Type">
            <FilterSelect debriefs={debriefs} field="sale_close_type" value={closeType} onChange={setCloseType} placeholder="All Close Types" />
          </Field>
          {setIdSearch && (
            <Field label="ID / Address Search">
              <input className="w-full border border-input rounded-lg px-3 py-2.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white" placeholder="Lead ID, Record ID, Job ID, Address…" value={idSearch} onChange={(e) => setIdSearch(e.target.value)} />
            </Field>
          )}
        </div>
      </div>

      {/* Chips + Clear + Count */}
      <div className="px-3 sm:px-4 py-3 flex flex-wrap items-center gap-2 border-t border-border/50 mt-2">
        {chips.map((c) => (
          <button key={c.key} onClick={c.clear} className="flex items-center gap-1 bg-accent/10 text-accent text-xs font-semibold px-2 py-1 rounded-full hover:bg-accent/20">
            {c.label} <X className="w-3 h-3" />
          </button>
        ))}
        {hasNonDateFilters && (
          <button onClick={clearAll} className="text-xs font-semibold text-muted-foreground hover:text-accent underline">Clear All Filters</button>
        )}
        <span className="text-xs text-muted-foreground ml-auto">Showing {filteredCount} of {dateTotalCount} debriefs</span>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}