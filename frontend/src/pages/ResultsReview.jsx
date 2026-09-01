import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { base44 } from "@/api/client";
import DebriefFilters from "@/components/DebriefFilters";
import { filterByDate, isSale, twoLegStats, appointmentQualityStats } from "@allied/shared/kpi";
import {
  DEMO_OUTCOMES, SALE_OUTCOMES,
  RESET_OUTCOMES, NON_COMPLETED_OUTCOMES
} from "@allied/shared/constants";
import { ChevronDown, ChevronRight, Loader2, FileText, Shield, Pencil, DollarSign } from "lucide-react";
import { isInsuranceDebrief } from "@allied/shared/insurance";
import { normalizeAppointmentType } from "@allied/shared/appointmentTypes";
import { classifyAppointment, classificationCounts, getRawDivisionDisplay } from "@allied/shared/appointmentClassification";
import { getMarketingCategory, isUnmappedSource, isSelfGenNeedsDetail, MARKETING_CATEGORIES } from "@allied/shared/marketingSources";
import ClassificationCounts from "@/components/ClassificationCounts";
import EditDebriefModal from "@/components/EditDebriefModal";
import RecordSaleLaterModal from "@/components/RecordSaleLaterModal";

export default function ResultsReview() {
  const [searchParams] = useSearchParams();
  const [filter, setFilter] = useState(searchParams.get("filter") || "This Month");
  const [cs, setCs] = useState(searchParams.get("cs") || "");
  const [ce, setCe] = useState(searchParams.get("ce") || "");
  const [rep, setRep] = useState(searchParams.get("rep") || "");
  const [setter, setSetter] = useState(searchParams.get("setter") || "");
  const [div, setDiv] = useState(searchParams.get("div") || "");
  const [outcome, setOutcome] = useState(searchParams.get("outcome") || "");
  const [source, setSource] = useState(searchParams.get("source") || "");
  const [dm, setDm] = useState(searchParams.get("dm") || "");
  const [closeType, setCloseType] = useState(searchParams.get("close") || "");
  const [clientName, setClientName] = useState("");
  const [city, setCity] = useState("");
  const [idSearch, setIdSearch] = useState("");
  const [insFilter, setInsFilter] = useState("all");
  const [reportingGroup, setReportingGroup] = useState("all");
  const [mktCategory, setMktCategory] = useState("");
  const [expandedId, setExpandedId] = useState(null);
  const [editing, setEditing] = useState(null);
  const [recordingSale, setRecordingSale] = useState(null);

  const { data: debriefs = [], isLoading } = useQuery({
    queryKey: ["debriefs"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });
  const { data: appointments = [] } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-created_date", 500)
  });

  // Lookup map: crm_lead_id → appointment title (for raw JobProgress title display)
  const apptTitleMap = useMemo(() => {
    const m = {};
    appointments.forEach((a) => {
      if (a.crm_lead_id) m[a.crm_lead_id.toLowerCase()] = a.title || "";
    });
    return m;
  }, [appointments]);
  // Lookup map: crm_lead_id → appointment product (JP Division for debrief enrichment)
  const apptProductMap = useMemo(() => {
    const m = {};
    appointments.forEach((a) => {
      if (a.crm_lead_id) m[a.crm_lead_id.toLowerCase()] = a.product || "";
    });
    return m;
  }, [appointments]);
  const enrichedDb = useMemo(() => debriefs.map((d) => ({
    ...d,
    title: d.title || apptTitleMap[(d.crm_lead_id || "").toLowerCase()] || "",
    product: d.product || apptProductMap[(d.crm_lead_id || "").toLowerCase()] || "",
  })), [debriefs, apptTitleMap, apptProductMap]);

  const filtered = useMemo(() => {
    let result = filterByDate(enrichedDb, "appointment_date", filter, cs, ce);
    if (rep) result = result.filter((d) => d.sales_rep === rep);
    if (setter) result = result.filter((d) => d.appointment_setter === setter);
    if (div) result = result.filter((d) => d.product === div);
    if (outcome) result = result.filter((d) => d.appointment_outcome === outcome);
    if (source) result = result.filter((d) => d.marketing_source === source);
    if (dm) result = result.filter((d) => d.decision_maker_status === dm);
    if (closeType) result = result.filter((d) => d.sale_close_type === closeType);
    if (city) result = result.filter((d) => d.city === city);
    if (clientName.trim()) {
      const q = clientName.toLowerCase().trim();
      result = result.filter((d) => d.customer_name && d.customer_name.toLowerCase().includes(q));
    }
    if (idSearch.trim()) {
      const q = idSearch.toLowerCase().trim();
      result = result.filter((d) =>
        [d.address, d.crm_lead_id, d.appointment_record_id, d.crm_job_id]
          .some((v) => v && v.toLowerCase().includes(q))
      );
    }
    if (insFilter === "insurance") result = result.filter(isInsuranceDebrief);
    else if (insFilter === "retail") result = result.filter((d) => !isInsuranceDebrief(d));
    if (mktCategory) result = result.filter((d) => getMarketingCategory(d.marketing_source) === mktCategory);
    if (reportingGroup !== "all") {
      const GROUP_MAP = { roofing: "Roofing", siding: "Siding", roofing_siding: "Roofing + Siding", commercial: "Commercial", repairs: "Repairs", misc: "Misc", insurance: "Insurance" };
      const target = GROUP_MAP[reportingGroup];
      result = result.filter((d) => classifyAppointment(d).reporting_division === target);
    }
    return result;
  }, [enrichedDb, filter, cs, ce, rep, setter, div, outcome, source, dm, closeType, city, clientName, idSearch, insFilter, reportingGroup, mktCategory]);

  const dateTotal = useMemo(() => filterByDate(enrichedDb, "appointment_date", filter, cs, ce).length, [enrichedDb, filter, cs, ce]);
  const classCounts = useMemo(() => classificationCounts(filterByDate(enrichedDb, "appointment_date", filter, cs, ce)), [enrichedDb, filter, cs, ce]);

  const summary = useMemo(() => {
    const sales = filtered.filter((d) => isSale(d)).length;
    const demos = filtered.filter((d) => DEMO_OUTCOMES.includes(d.appointment_outcome)).length;
    const tl = twoLegStats(filtered);
    const oneLeg = filtered.filter((d) => d.decision_maker_status === "One-Leg").length;
    const revenue = filtered.filter((d) => isSale(d)).reduce((s, d) => s + (Number(d.sale_amount) || 0), 0);
    const aq = appointmentQualityStats(filtered);
    const legacyDemoRate = aq.aqLegacyDenom > 0 ? Math.round((aq.aqLegacyDemos / aq.aqLegacyDenom) * 100) : 0;
    return { total: filtered.length, sales, demos, twoLeg: tl.twoLeg, twoLegDenom: tl.denominator, twoLegPct: tl.rate, oneLeg, revenue,
      demoRate: aq.demoRate, aqDemos: aq.aqDemos, aqOpportunities: aq.aqOpportunities,
      noDemo: aq.aqNoDemo, noDemoRate: aq.noDemoRate, noSee: aq.aqNoSee, noSeeRate: aq.noSeeRate,
      resetNeeded: aq.aqResetNeeded, resetRate: aq.resetRate, completedResetDemos: aq.aqCompletedResetDemo, resetRecoveryRate: aq.resetRecoveryRate,
      legacyDemoRate };
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Results Review</h1>
        <p className="text-sm text-muted-foreground">Read-only debrief answers for managers.</p>
      </div>

      <DebriefFilters
        debriefs={debriefs}
        filter={filter} setFilter={setFilter} cs={cs} setCs={setCs} ce={ce} setCe={setCe}
        clientName={clientName} setClientName={setClientName}
        city={city} setCity={setCity}
        rep={rep} setRep={setRep}
        setter={setter} setSetter={setSetter}
        div={div} setDiv={setDiv}
        outcome={outcome} setOutcome={setOutcome}
        dm={dm} setDm={setDm}
        source={source} setSource={setSource}
        closeType={closeType} setCloseType={setCloseType}
        idSearch={idSearch} setIdSearch={setIdSearch}
        dateTotalCount={dateTotal}
        filteredCount={filtered.length}
      />

      {/* Reporting Group filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Reporting Group:</span>
        {[
          { key: "all", label: "All" },
          { key: "roofing", label: "Roofing" },
          { key: "siding", label: "Siding" },
          { key: "roofing_siding", label: "Roofing + Siding" },
          { key: "commercial", label: "Commercial" },
          { key: "repairs", label: "Repairs" },
          { key: "misc", label: "Misc" },
          { key: "insurance", label: "Insurance" },
        ].map((g) => (
          <button key={g.key} onClick={() => setReportingGroup(g.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              reportingGroup === g.key ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {g.label}
          </button>
        ))}
      </div>

      <ClassificationCounts counts={classCounts} />

      {/* Marketing Category filter */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground">Marketing Category:</span>
        <select value={mktCategory} onChange={(e) => setMktCategory(e.target.value)}
          className="text-xs border border-input rounded-lg px-2 py-1.5 font-medium bg-white max-w-xs">
          <option value="">All Categories</option>
          {MARKETING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {mktCategory && <button onClick={() => setMktCategory("")} className="text-xs font-semibold text-accent underline">Clear</button>}
      </div>

      {/* Insurance filter toggle */}
      <div className="flex items-center gap-2">
        {["all", "insurance", "retail"].map((f) => (
          <button key={f} onClick={() => setInsFilter(f)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              insFilter === f ? "bg-accent text-white" : "bg-white border border-border text-secondary-foreground"
            }`}>
            {f === "all" ? "All Records" : f === "insurance" ? "Insurance Only" : "Retail / Commercial Only"}
          </button>
        ))}
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <SummaryStat label="Records" value={summary.total} />
        <SummaryStat label="Demos" value={summary.demos} />
        <SummaryStat label="Sales" value={summary.sales} />
        <SummaryStat label="Two-Leg" value={summary.twoLegDenom > 0 ? summary.twoLeg : 0} />
        <SummaryStat label="Two-Leg %" value={summary.twoLegDenom > 0 ? summary.twoLegPct + "%" : "N/A"} title="Roofing, Siding, Roofing + Siding eligible subset only" />
        <SummaryStat label="Revenue" value={"$" + summary.revenue.toLocaleString()} />
      </div>

      <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
        <SummaryStat label="Demo Rate" value={summary.demoRate + "%"} />
        <SummaryStat label="No Demo" value={summary.noDemo} />
        <SummaryStat label="No Demo Rate" value={summary.noDemoRate + "%"} />
        <SummaryStat label="No See" value={summary.noSee} />
        <SummaryStat label="No See Rate" value={summary.noSeeRate + "%"} />
        <SummaryStat label="Reset Needed" value={summary.resetNeeded} />
        <SummaryStat label="Reset Rate" value={summary.resetRate + "%"} />
        <SummaryStat label="Reset Recovery" value={summary.resetRecoveryRate + "%"} />
        <SummaryStat label="Legacy Overall Demo %" value={summary.legacyDemoRate + "%"} />
      </div>

      {/* List */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <div className="bg-white rounded-xl border border-border p-8 text-center shadow-sm">
          <FileText className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">No debriefs match the current filters.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((d) => (
            <DebriefRow key={d.id} debrief={d} rawTitle={apptTitleMap[(d.crm_lead_id || "").toLowerCase()] || ""} expanded={expandedId === d.id} onToggle={() => setExpandedId(expandedId === d.id ? null : d.id)}
              onEdit={() => setEditing(d)} onRecordSale={() => setRecordingSale(d)} />
          ))}
        </div>
      )}

      <EditDebriefModal debrief={editing} onClose={() => setEditing(null)} />
      <RecordSaleLaterModal debrief={recordingSale} onClose={() => setRecordingSale(null)} />
    </div>
  );
}

function SummaryStat({ label, value, title }) {
  return (
    <div className="bg-white rounded-lg border border-border p-2.5 text-center shadow-sm" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className="text-lg font-heading font-bold text-primary">{value}</div>
    </div>
  );
}

function DebriefRow({ debrief: d, rawTitle, expanded, onToggle, onEdit, onRecordSale }) {
  const hasLaterSale = d.sale_signed_date && Number(d.sale_amount) > 0;
  return (
    <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
      <button onClick={onToggle} className="w-full flex items-center justify-between p-3 sm:p-4 text-left hover:bg-secondary/30 transition-colors">
        <div className="flex items-center gap-3 min-w-0">
          {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-sm text-primary truncate">{d.customer_name || "Unnamed"}</span>
              {isInsuranceDebrief(d) && (
                <span className="inline-flex items-center gap-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
                  <Shield className="w-2.5 h-2.5" /> Insurance
                </span>
              )}
              {hasLaterSale && (
                <span className="inline-flex items-center gap-0.5 bg-green-100 text-green-800 text-[10px] font-bold px-1.5 py-0.5 rounded-full whitespace-nowrap">
                  <DollarSign className="w-2.5 h-2.5" /> Later Sale {d.sale_signed_date} • ${Number(d.sale_amount).toLocaleString()}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {d.appointment_date || "—"} • {getRawDivisionDisplay(d, true)}{d.trade ? ` / ${d.trade}` : ""} • {d.sales_rep || "—"} • {d.appointment_outcome || "—"}
            </div>
          </div>
        </div>
        <div className="flex-shrink-0 ml-2">
          <StatusBadge outcome={d.appointment_outcome} />
        </div>
      </button>
      {expanded && <DetailPanel debrief={d} rawTitle={rawTitle} onEdit={onEdit} onRecordSale={onRecordSale} />}
    </div>
  );
}

function StatusBadge({ outcome }) {
  if (!outcome) return null;
  let cls = "bg-secondary text-secondary-foreground";
  if (SALE_OUTCOMES.includes(outcome)) cls = "bg-green-100 text-green-800";
  else if (DEMO_OUTCOMES.includes(outcome)) cls = "bg-blue-100 text-blue-800";
  else if (RESET_OUTCOMES.includes(outcome)) cls = "bg-amber-100 text-amber-800";
  else if (NON_COMPLETED_OUTCOMES.includes(outcome)) cls = "bg-gray-100 text-gray-600";
  return <span className={`text-[10px] font-semibold px-2 py-1 rounded-full whitespace-nowrap ${cls}`}>{outcome}</span>;
}

function DetailPanel({ debrief: d, rawTitle, onEdit, onRecordSale }) {
  const c = classifyAppointment(d);
  return (
    <div className="border-t border-border p-4 space-y-4 bg-secondary/10">
      <div className="flex flex-wrap gap-2 no-print">
        <button onClick={onEdit} className="inline-flex items-center gap-1.5 bg-primary text-primary-foreground text-sm font-semibold px-3 py-2 rounded-lg hover:bg-primary/90">
          <Pencil className="w-4 h-4" /> Edit Debrief
        </button>
        <button onClick={onRecordSale} className="inline-flex items-center gap-1.5 bg-accent text-white text-sm font-semibold px-3 py-2 rounded-lg hover:bg-accent/90">
          <DollarSign className="w-4 h-4" /> Record Sale Later
        </button>
      </div>
      <Group title="Client & Appointment" fields={[
        ["Customer", d.customer_name],
        ["Street Address", d.address],
        ["City", d.city],
        ["Lead ID / JobProgress ID", d.crm_lead_id],
        ["Appointment Record ID", d.appointment_record_id],
        ["CRM Job ID", d.crm_job_id],
        ["Appointment Date", d.appointment_date],
        ["Appointment Type", normalizeAppointmentType(d.appointment_type) || d.appointment_type],
        ["Raw JobProgress Title", rawTitle],
        ["Raw Division", getRawDivisionDisplay(d)],
        ["Reporting Division", c.reporting_division],
        ["Reporting Trade", c.reporting_trade],
        ["Classification Source", c.classification_source],
        ["Classification Conflict", c.classification_conflict ? "Yes — " + c.conflict_reason : "No"],
        ["Sales Rep", d.sales_rep],
        ["Appointment Setter", d.appointment_setter],
        ["Marketing Source", d.marketing_source],
        ["Marketing Category", getMarketingCategory(d.marketing_source) + (isSelfGenNeedsDetail(d.marketing_source) ? "  ⚠ Self-gen — needs subtype" : (isUnmappedSource(d.marketing_source) ? "  ⚠ Needs cleanup" : ""))],
        ["Referral Source", d.referral_source],
        ["Self-Gen Source", d.self_gen_source],
      ]} />

      <Group title="Result" fields={[
        ["Appointment Outcome", d.appointment_outcome],
        ["Sales Appointment?", d.sales_appointment],
        ["Non-Sales Reason", d.non_sales_reason],
        ["Decision Maker Status", d.decision_maker_status],
        ["One-Leg Reason", d.one_leg_reason],
        ["No-Demo Reason", (!DEMO_OUTCOMES.includes(d.appointment_outcome) && d.appointment_outcome) ? d.appointment_outcome : null],
      ]} />

      <Group title="Presentation & Pricing" fields={[
        ["Products Discussed", d.products_discussed],
        ["Price 1 Given", d.first_price_given != null && d.first_price_given !== "" ? "$" + Number(d.first_price_given).toLocaleString() : null],
        ["Price 2 Given", d.price_2_given != null && d.price_2_given !== "" ? "$" + Number(d.price_2_given).toLocaleString() : null],
        ["Price 3 Given", d.price_3_given != null && d.price_3_given !== "" ? "$" + Number(d.price_3_given).toLocaleString() : null],
        ["Additional Prices Given", d.additional_prices_given],
        ["Prices Given Count", d.prices_given],
        ["Financing Offered", d.financing_offered === true ? "Yes" : (d.financing_offered === false ? "No" : null)],
        ["Financing Not Offered Reason", d.financing_not_offered_reason],
        ["Financing Option Presented", d.financing_option_presented],
        ["Financing Result", d.financing_result],
      ]} />

      <Group title="Objection (Step 8)" fields={[
        ["Main Objection", d.main_objection],
        ["Objection — Exact Customer Wording", d.objection_customer_wording],
        ["Pre-Close Answer (Step 7)", d.pre_close_answer],
        ["Client Response 2", d.client_response_2],
        ["Rep Response 3", d.rep_response_3],
      ]} />

      <Group title="Step 7 — Close Review" fields={[
        ["Step 7 Result", d.step7_result],
        ["Customer said to closing question", d.step7_result === "Positive / False Positive" ? d.closing_question_answer : null],
        ["What did you say first", d.step7_result === "Positive / False Positive" ? d.rep_response : null],
        ["What did you say next", d.step7_result === "Positive / False Positive" ? d.rep_response_2 : null],
        ["Walk-of-Life Issues", d.walk_of_life_issues],
        ["How did you respond", d.step7_result === "Negative" ? d.rep_response : null],
        ["Customer said to WDTS", d.step7_result === "Negative" ? d.client_response_1 : null],
        ["Coaching Follow-Up", d.step7_coaching_followup],
        ["Things to Review", d.step7_things_to_review],
        ["Coaching Notes", d.step7_coaching_notes],
      ]} />

      <Group title="Follow-Up" fields={[
        ["Reset Needed", d.reset_needed === true ? "Yes" : (d.reset_needed === false ? "No" : null)],
        ["Reset Status", d.reset_status],
        ["Reset Date", d.reset_date],
        ["Reset Reason", d.reset_reason],
        ["Reset Appointment Scheduled", d.reset_appointment_scheduled === true ? "Yes" : (d.reset_appointment_scheduled === false ? "No" : null)],
        ["Reset Follow-Up Needed", d.reset_follow_up_notes],
        ["Follow-Up Needed", d.follow_up_needed === true ? "Yes" : (d.follow_up_needed === false ? "No" : null)],
        ["Follow-Up Bucket", d.follow_up_bucket],
        ["Follow-Up Date", d.follow_up_date],
        ["Estimate Sent Date", d.estimate_sent_date ? new Date(d.estimate_sent_date).toLocaleString() : null],
      ]} />

      <Group title="Sale" fields={[
        ["Sale Amount (full job)", d.sale_amount != null && d.sale_amount !== "" ? "$" + Number(d.sale_amount).toLocaleString() : null],
        ["Primary Sales Rep", d.sales_rep],
        ["Secondary Sales Rep", d.secondary_sales_rep],
        ["Primary Split %", d.secondary_sales_rep ? (d.primary_rep_split_pct != null ? d.primary_rep_split_pct + "%" : "100%") : "100%"],
        ["Secondary Split %", d.secondary_sales_rep ? (d.secondary_rep_split_pct != null ? d.secondary_rep_split_pct + "%" : "0%") : null],
        ["Primary Revenue Credit", d.sale_amount != null && d.sale_amount !== "" ? "$" + Math.round(Number(d.sale_amount) * (d.primary_rep_split_pct != null ? Number(d.primary_rep_split_pct) : 100) / 100).toLocaleString() : null],
        ["Secondary Revenue Credit", d.sale_amount != null && d.secondary_sales_rep && d.secondary_rep_split_pct != null ? "$" + Math.round(Number(d.sale_amount) * Number(d.secondary_rep_split_pct) / 100).toLocaleString() : null],
        ["Sale Signed Date", d.sale_signed_date],
        ["Sale / Close Type", d.sale_close_type],
        ["Sale Price #", d.sale_price_number],
        ["Sale Date", d.sale_date],
        ["Credit Decline", d.credit_decline === true ? "Yes" : (d.credit_decline === false ? "No" : null)],
        ["Cancellation", d.cancellation === true ? "Yes" : (d.cancellation === false ? "No" : null)],
        ["Cancellation Reason", d.cancellation_reason],
      ]} />

      <Group title="Notes & Audit" fields={[
        ["Notes", d.notes],
        ["Historical Review", d.historical_review],
        ["Data Quality Flag", d.data_quality_flag],
        ["Manager Review Needed", d.manager_review_needed === true ? "Yes" : null],
        ["Submitted By", d.submitted_by],
        ["Submitted Date/Time", d.created_date ? new Date(d.created_date).toLocaleString() : null],
        ["Lead / Referral Received Date", d.lead_referral_date],
        ["Result Source", d.result_source],
        ["Last Edited By", d.last_edited_by],
        ["Last Edited At", d.last_edited_at ? new Date(d.last_edited_at).toLocaleString() : null],
        ["Edit Reason", d.edit_reason],
      ]} />

      {isInsuranceDebrief(d) && (
        <Group title="Insurance" fields={[
          ["Business Division", d.business_division || "Insurance"],
          ["Trade", d.trade],
          ["Contingency Signed", d.contingency_signed === true ? "Yes" : (d.contingency_signed === false ? "No" : null)],
          ["Contingency Signed Date", d.contingency_signed_date],
          ["Demo Completed", d.demo_completed === true ? "Yes" : (d.demo_completed === false ? "No" : null)],
          ["Insurance Outcome", d.insurance_outcome],
          ["Upgrade Price 1", d.upgrade_price_1 != null && d.upgrade_price_1 !== "" ? "$" + Number(d.upgrade_price_1).toLocaleString() : null],
          ["Upgrade Price 2", d.upgrade_price_2 != null && d.upgrade_price_2 !== "" ? "$" + Number(d.upgrade_price_2).toLocaleString() : null],
          ["Upgrade Price 3", d.upgrade_price_3 != null && d.upgrade_price_3 !== "" ? "$" + Number(d.upgrade_price_3).toLocaleString() : null],
          ["Other Prices Given", d.other_prices_given === true ? "Yes" : (d.other_prices_given === false ? "No" : null)],
          ["Other Prices Details", d.other_prices_details],
          ["Other Prices Amount", d.other_prices_amount != null && d.other_prices_amount !== "" ? "$" + Number(d.other_prices_amount).toLocaleString() : null],
          ["Total Job Price Provided", d.total_job_price_provided === true ? "Yes" : (d.total_job_price_provided === false ? "No" : null)],
          ["Total Job Price", d.total_job_price != null && d.total_job_price !== "" ? "$" + Number(d.total_job_price).toLocaleString() : null],
          ["Upgrade Sold / Accepted", d.upgrade_sold_accepted === true ? "Yes" : (d.upgrade_sold_accepted === false ? "No" : null)],
          ["Accepted Upgrade Amount", d.accepted_upgrade_amount != null && d.accepted_upgrade_amount !== "" ? "$" + Number(d.accepted_upgrade_amount).toLocaleString() : null],
          ["Final Contract Signed", d.final_contract_signed === true ? "Yes" : (d.final_contract_signed === false ? "No" : null)],
          ["Final Contract Date", d.final_contract_date],
        ]} />
      )}
    </div>
  );
}

function Group({ title, fields }) {
  const populated = fields.filter(([, v]) => v !== null && v !== undefined && v !== "" && v !== false);
  if (populated.length === 0) return null;
  return (
    <div>
      <h3 className="text-[11px] font-heading font-bold text-primary uppercase tracking-wide mb-1.5">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
        {populated.map(([label, value]) => (
          <div key={label} className="flex flex-col sm:flex-row sm:gap-2 text-sm">
            <span className="font-semibold text-muted-foreground sm:w-40 flex-shrink-0">{label}:</span>
            <span className="text-foreground break-words">{String(value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}