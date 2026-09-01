import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/components/ui/use-toast";
import { CheckCircle2, Loader2 } from "lucide-react";
import {
  SALE_OUTCOMES, DEMO_NO_SALE_OUTCOME, SALE_CANCELLATION_OUTCOME, RESET_OUTCOMES,
  TRADES, INSURANCE_OUTCOMES, APPOINTMENT_TYPE_HELP_TEXT
} from "@allied/shared/constants";
import { dataQualityFlags } from "@allied/shared/kpi";
import { normalizeAppointmentType } from "@allied/shared/appointmentTypes";
import { resolveAppointmentForDebrief, findExistingDebrief, isValidId } from "@allied/shared/appointmentMatching";
import ComboSelect from "@/components/ComboSelect";
import SubmittedBySelect from "@/components/SubmittedBySelect";
import { getMarketingCategory, isUnmappedSource, isSelfGenNeedsDetail } from "@allied/shared/marketingSources";

const PRODUCTS_PRESENTED = [
  "Roofing", "Siding", "Roofing + Siding", "Gutters", "Windows", "Doors",
  "Chimney", "Repair/Service", "Commercial", "Other"
];
const WALK_OF_LIFE = ["Did not find out when", "Did not find out how", "Did not go to the correct partial", "None"];
const STEP7_FOLLOWUP = ["Review Primary", "Review Secondary", "Role-play at next sales meeting", "None"];
const STEP7_THINGS = [
  "Did not call the reference list", "Did not ask transition questions correctly",
  "Did not shoot the video properly", "Did not get all decision makers involved", "None"
];

const EMPTY = {
  customer_name: "", address: "", city: "", crm_lead_id: "", appointment_date: "",
  sales_rep: "", appointment_setter: "", product: "", appointment_type: "", appointment_outcome: "",
  decision_maker_status: "", one_leg_reason: "", products_discussed: "", products_presented_other: "",
  first_price_given: "", price_2_given: "", price_3_given: "",
  additional_prices_given: "", prices_given: "",
  financing_offered: null, financing_not_offered_reason: "", financing_option_presented: "", financing_result: "",
  sale_amount: "", sale_close_type: "", sale_price_number: "", main_objection: "", objection_customer_wording: "",
  secondary_sales_rep: "", primary_rep_split_pct: "", secondary_rep_split_pct: "",
  pre_close_answer: "", closing_question_answer: "",
  step7_result: "", walk_of_life_issues: "", step7_coaching_notes: "", step7_coaching_followup: "", step7_things_to_review: "",
  rep_response: "", client_response_1: "", rep_response_2: "", client_response_2: "", rep_response_3: "", cancellation_reason: "",
  reset_needed: false, reset_status: "", reset_date: "", reset_reason: "",
  reset_appointment_scheduled: null, reset_follow_up_notes: "",
  follow_up_needed: false, follow_up_bucket: "", follow_up_date: "",
  notes: "", marketing_source: "", referral_source: "", submitted_by: "",
  business_division: "", trade: "",
  contingency_signed: null, contingency_signed_date: "", demo_completed: null,
  insurance_outcome: "", upgrade_price_1: "", upgrade_price_2: "", upgrade_price_3: "",
  other_prices_given: null, other_prices_details: "", other_prices_amount: "",
  total_job_price_provided: null, total_job_price: "",
  upgrade_sold_accepted: null, accepted_upgrade_amount: "",
  final_contract_signed: null, final_contract_date: ""
};

export default function SubmitDebrief() {
  const [form, setForm] = useState(EMPTY);
  const [submitting, setSubmitting] = useState(false);
  const [gaveSecondPrice, setGaveSecondPrice] = useState(false);
  const [gaveThirdPrice, setGaveThirdPrice] = useState(false);
  const navigate = useNavigate();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const { data: appointments = [] } = useQuery({
    queryKey: ["appointments-all"],
    queryFn: () => base44.entities.Appointment.list("-created_date", 500)
  });
  const { data: debriefs = [] } = useQuery({
    queryKey: ["debriefs-all"],
    queryFn: () => base44.entities.Debrief.list("-created_date", 500)
  });

  const appointmentId = new URLSearchParams(window.location.search).get("appointment_id");
  const { data: prefillAppt } = useQuery({
    queryKey: ["appointment-prefill", appointmentId],
    queryFn: () => appointmentId ? base44.entities.Appointment.get(appointmentId) : null,
    enabled: !!appointmentId
  });

  useEffect(() => {
    if (me?.full_name && !form.submitted_by) {
      setForm((f) => ({ ...f, submitted_by: me.full_name }));
    }
  }, [me]);

  useEffect(() => {
    if (prefillAppt && !form.customer_name) {
      setForm((f) => ({
        ...f,
        customer_name: prefillAppt.customer_name || "",
        address: prefillAppt.address || "",
        city: prefillAppt.city || "",
        crm_lead_id: prefillAppt.crm_lead_id || "",
        appointment_date: prefillAppt.appointment_date || "",
        sales_rep: prefillAppt.original_sales_rep || "",
        appointment_setter: prefillAppt.original_appointment_setter || "",
        product: prefillAppt.product || "",
        marketing_source: prefillAppt.marketing_source || "",
        referral_source: prefillAppt.referral_source || "",
        submitted_by: me?.full_name || f.submitted_by
      }));
    }
  }, [prefillAppt, me]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const outcome = form.appointment_outcome;
  const isSale = SALE_OUTCOMES.includes(outcome);
  const isDemoNoSale = outcome === DEMO_NO_SALE_OUTCOME;
  const isCancellation = outcome === SALE_CANCELLATION_OUTCOME;
  const isResetNeeded = RESET_OUTCOMES.includes(outcome);
  const isResetDemo = form.appointment_type === "Reset Demo";
  const isInsurance = form.product === "Insurance" || form.business_division === "Insurance";
  const showResetSection = (isResetNeeded || isResetDemo) && !isInsurance;
  const showOneLegReason = form.decision_maker_status === "One-Leg";

  const valid = (() => {
    const base = isInsurance
      ? ["customer_name", "appointment_date", "sales_rep", "appointment_setter", "insurance_outcome", "submitted_by"]
      : ["customer_name", "appointment_date", "sales_rep", "appointment_setter", "appointment_outcome", "submitted_by"];
    for (const k of base) if (!String(form[k] || "").trim()) return false;
    if (isDemoNoSale && !isInsurance) {
      if (!String(form.decision_maker_status || "").trim()) return false;
      if (!String(form.first_price_given || "").trim()) return false;
      if (!String(form.step7_result || "").trim()) return false;
      if (form.decision_maker_status === "One-Leg" && !String(form.one_leg_reason || "").trim()) return false;
      if (form.financing_offered === false && !String(form.financing_not_offered_reason || "").trim()) return false;
    }
    if (showResetSection) {
      if (!String(form.reset_reason || "").trim()) return false;
      if (form.reset_appointment_scheduled === null) return false;
      if (form.reset_appointment_scheduled === true && !String(form.reset_date || "").trim()) return false;
      if (form.reset_appointment_scheduled === false && !String(form.reset_follow_up_notes || "").trim()) return false;
    }
    // Split-sale validation: when a secondary rep is set, both split % must be 0–100 and total exactly 100.
    if (isSale && !isInsurance && String(form.secondary_sales_rep || "").trim()) {
      const p = Number(form.primary_rep_split_pct);
      const s = Number(form.secondary_rep_split_pct);
      if (!Number.isFinite(p) || !Number.isFinite(s)) return false;
      if (p < 0 || p > 100 || s < 0 || s > 100) return false;
      if (Math.round(p + s) !== 100) return false;
    }
    return true;
  })();

  async function handleSubmit(e) {
    e.preventDefault();
    if (!valid) {
      toast({ title: "Missing required fields", description: "Please complete all required fields.", variant: "destructive" });
      return;
    }
    setSubmitting(true);
    const result = { debriefAction: null, debriefId: null, appointmentAction: "none", appointmentId: null, matched: false, warning: null, error: null };
    try {
      const resolution = resolveAppointmentForDebrief(form, appointments);
      const existingDebrief = findExistingDebrief(form, debriefs);
      const baseFlags = dataQualityFlags({ ...form, matched: resolution.status === "matched" });

      const payload = {
        ...form,
        first_price_given: form.first_price_given ? Number(form.first_price_given) : undefined,
        price_2_given: form.price_2_given ? Number(form.price_2_given) : undefined,
        price_3_given: form.price_3_given ? Number(form.price_3_given) : undefined,
        sale_amount: form.sale_amount ? Number(form.sale_amount) : undefined,
        prices_given: form.prices_given ? Number(form.prices_given) : undefined,
        reset_needed: isResetNeeded ? true : form.reset_needed,
        upgrade_price_1: form.upgrade_price_1 ? Number(form.upgrade_price_1) : undefined,
        upgrade_price_2: form.upgrade_price_2 ? Number(form.upgrade_price_2) : undefined,
        upgrade_price_3: form.upgrade_price_3 ? Number(form.upgrade_price_3) : undefined,
        other_prices_amount: form.other_prices_amount ? Number(form.other_prices_amount) : undefined,
        total_job_price: form.total_job_price ? Number(form.total_job_price) : undefined,
        accepted_upgrade_amount: form.accepted_upgrade_amount ? Number(form.accepted_upgrade_amount) : undefined,
        business_division: isInsurance ? "Insurance" : (form.business_division || ""),
        appointment_outcome: isInsurance && form.insurance_outcome
          ? `Insurance: ${form.insurance_outcome}`
          : form.appointment_outcome,
        appointment_type: normalizeAppointmentType(form.appointment_type),
        // Split-sale: store the full sale amount once; derive each rep's credit from split %.
        secondary_sales_rep: isSale && !isInsurance ? (form.secondary_sales_rep || "") : "",
        primary_rep_split_pct: isSale && !isInsurance
          ? (form.secondary_sales_rep ? (Number(form.primary_rep_split_pct) || 50) : (Number(form.primary_rep_split_pct) || 100))
          : undefined,
        secondary_rep_split_pct: isSale && !isInsurance && form.secondary_sales_rep
          ? (Number(form.secondary_rep_split_pct) || 50)
          : (isSale && !isInsurance ? 0 : undefined),
      };

      if (resolution.status === "matched" && isValidId(resolution.appointmentId)) {
        payload.appointment_id = resolution.appointmentId;
        payload.appointment_record_id = payload.appointment_record_id || resolution.appointment.appointment_record_id || "";
        payload.crm_lead_id = payload.crm_lead_id || resolution.appointment.crm_lead_id || "";
        if (!payload.marketing_source && resolution.appointment.marketing_source) payload.marketing_source = resolution.appointment.marketing_source;
        if (!payload.referral_source && resolution.appointment.referral_source) payload.referral_source = resolution.appointment.referral_source;
        payload.matched = true;
        payload.manager_review_needed = baseFlags.length > 0;
        payload.data_quality_flag = baseFlags.join("; ");
      } else {
        payload.matched = false;
        payload.manager_review_needed = true;
        const reviewTag = resolution.status === "ambiguous" ? "Ambiguous match — needs review" : "Unmatched — appointment needs matching";
        payload.data_quality_flag = [baseFlags.join("; "), reviewTag].filter((s) => s && s.trim()).join("; ");
      }

      if (existingDebrief) {
        await base44.entities.Debrief.update(existingDebrief.id, payload);
        result.debriefAction = "updated";
        result.debriefId = existingDebrief.id;
      } else {
        const created = await base44.entities.Debrief.create(payload);
        result.debriefAction = "created";
        result.debriefId = created.id;
      }
      result.appointmentId = resolution.appointmentId;

      // Link the Appointment only when a real internal id was resolved — invariant guard.
      if (resolution.status === "matched" && isValidId(resolution.appointmentId)) {
        try {
          await base44.entities.Appointment.update(resolution.appointmentId, { debrief_status: "Submitted" });
          result.appointmentAction = "linked";
          result.matched = true;
        } catch (linkErr) {
          result.appointmentAction = "link_failed";
          result.warning = `Debrief saved but appointment link failed: ${linkErr.message}`;
          try {
            await base44.entities.Debrief.update(result.debriefId, {
              manager_review_needed: true,
              data_quality_flag: [payload.data_quality_flag, "Appointment link failed"].filter(Boolean).join("; "),
            });
          } catch { /* best-effort flag update */ }
        }
      } else {
        result.warning = resolution.status === "ambiguous"
          ? "Ambiguous match — sent to Exceptions for review."
          : "Debrief saved; appointment needs matching.";
      }

      qc.invalidateQueries({ queryKey: ["debriefs"] });
      qc.invalidateQueries({ queryKey: ["debriefs-all"] });
      qc.invalidateQueries({ queryKey: ["appointments-all"] });

      if (result.matched && result.appointmentAction === "linked") {
        toast({ title: "Debrief saved & linked", description: `Matched via ${resolution.matchMethod}.` });
      } else {
        toast({ title: "Debrief saved; appointment needs matching", description: result.warning || "Recorded successfully." });
      }

      setForm({ ...EMPTY, submitted_by: me?.full_name || "" });
      setGaveSecondPrice(false);
      setGaveThirdPrice(false);
      setTimeout(() => navigate("/queue"), 800);
      return result;
    } catch (err) {
      result.error = err.message;
      // Pre-save validation error — nothing was saved.
      toast({ title: "Submission failed", description: err.message, variant: "destructive" });
      return result;
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl mx-auto space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Submit Debrief</h1>
        <p className="text-sm text-muted-foreground">Fast capture — under 2 minutes.</p>
      </div>

      <Section title="Customer Info">
        <Field label="Customer Name *" required>
          <input className={inputCls} value={form.customer_name} onChange={(e) => set("customer_name", e.target.value)} />
        </Field>
        <Field label="Street Address">
          <input className={inputCls} value={form.address} onChange={(e) => set("address", e.target.value)} placeholder="123 Main St" />
        </Field>
        <Field label="City">
          <input className={inputCls} value={form.city} onChange={(e) => set("city", e.target.value)} placeholder="City" />
        </Field>
        <Field label="Lead ID / JobProgress ID" hint="Optional but preferred — enables auto-match">
          <input className={inputCls} value={form.crm_lead_id} onChange={(e) => set("crm_lead_id", e.target.value)} />
        </Field>
        <Field label="Appointment Date *" required>
          <input type="date" className={inputCls} value={form.appointment_date} onChange={(e) => set("appointment_date", e.target.value)} />
        </Field>
        <Field label="Marketing Source" hint="Auto-filled from lead if matched; category auto-derived">
          <ComboSelect category="marketing_source" value={form.marketing_source} onChange={(v) => set("marketing_source", v)} placeholder="Select or add source" />
          {form.marketing_source && (
            <div className="text-xs text-muted-foreground mt-1">
              Category: <span className="font-semibold text-foreground">{getMarketingCategory(form.marketing_source)}</span>
              {isSelfGenNeedsDetail(form.marketing_source) && (
                <span className="ml-1 text-amber-600 font-semibold" title="Valid self-generated lead — select a specific subtype going forward">⚠ Self-gen — needs subtype</span>
              )}
              {isUnmappedSource(form.marketing_source) && (
                <span className="ml-1 text-red-600 font-semibold">⚠ Needs cleanup</span>
              )}
            </div>
          )}
        </Field>
      </Section>

      <Section title="Rep & Division">
        <Field label="Sales Rep *" required>
          <ComboSelect category="sales_rep" value={form.sales_rep} onChange={(v) => set("sales_rep", v)} placeholder="Select or add rep" />
        </Field>
        <Field label="Appointment Setter *" required>
          <ComboSelect category="appointment_setter" value={form.appointment_setter} onChange={(v) => set("appointment_setter", v)} placeholder="Select or add setter" />
        </Field>
        <Field label="Division">
          <ComboSelect category="product" value={form.product} onChange={(v) => {
            set("product", v);
            if (v === "Insurance") set("business_division", "Insurance");
            else if (form.business_division === "Insurance") set("business_division", "");
          }} placeholder="Select or add division" />
        </Field>
        {isInsurance && (
          <Field label="Trade *" required hint="Insurance trade for this job">
            <select className={inputCls} value={form.trade} onChange={(e) => set("trade", e.target.value)}>
              <option value="">Select…</option>
              {TRADES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        )}
      </Section>

      <Section title="Appointment Details">
        <Field label="Appointment Type" hint={APPOINTMENT_TYPE_HELP_TEXT}>
          <ComboSelect category="appointment_type" value={form.appointment_type} onChange={(v) => set("appointment_type", v)} placeholder="Select type" normalizeValue={normalizeAppointmentType} />
        </Field>
        {!isInsurance && (
          <Field label="Appointment Outcome *" required>
            <ComboSelect category="appointment_outcome" value={form.appointment_outcome} onChange={(v) => set("appointment_outcome", v)} placeholder="Select outcome" />
            <span className="block text-xs text-muted-foreground mt-1">Demo = a substantial residential presentation, typically about one hour, in which the rep showed products and gave the customer a price.</span>
          </Field>
        )}
      </Section>

      {isInsurance && (
        <Section title="Insurance Debrief">
          <Field label="Contingency Signed?">
            <YesNoRadio value={form.contingency_signed} onChange={(v) => set("contingency_signed", v)} />
          </Field>
          {form.contingency_signed === true && (
            <Field label="Contingency Signed Date">
              <input type="date" className={inputCls} value={form.contingency_signed_date} onChange={(e) => set("contingency_signed_date", e.target.value)} />
            </Field>
          )}

          <Field label="Demo Completed?">
            <YesNoRadio value={form.demo_completed} onChange={(v) => set("demo_completed", v)} />
          </Field>

          <Field label="Insurance Outcome / Status *" required>
            <select className={inputCls} value={form.insurance_outcome} onChange={(e) => set("insurance_outcome", e.target.value)}>
              <option value="">Select…</option>
              {INSURANCE_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <Field label="Upgrade Price 1">
              <input type="number" inputMode="decimal" className={inputCls} value={form.upgrade_price_1} onChange={(e) => set("upgrade_price_1", e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Upgrade Price 2">
              <input type="number" inputMode="decimal" className={inputCls} value={form.upgrade_price_2} onChange={(e) => set("upgrade_price_2", e.target.value)} placeholder="0.00" />
            </Field>
            <Field label="Upgrade Price 3">
              <input type="number" inputMode="decimal" className={inputCls} value={form.upgrade_price_3} onChange={(e) => set("upgrade_price_3", e.target.value)} placeholder="0.00" />
            </Field>
          </div>

          <Field label="Were any other prices given?">
            <YesNoRadio value={form.other_prices_given} onChange={(v) => set("other_prices_given", v)} />
          </Field>
          {form.other_prices_given === true && (
            <>
              <Field label="Other prices — details">
                <textarea className={inputCls + " min-h-20"} value={form.other_prices_details} onChange={(e) => set("other_prices_details", e.target.value)} />
              </Field>
              <Field label="Other prices amount (optional)">
                <input type="number" inputMode="decimal" className={inputCls} value={form.other_prices_amount} onChange={(e) => set("other_prices_amount", e.target.value)} placeholder="0.00" />
              </Field>
            </>
          )}

          <Field label="Was a total job price provided?">
            <YesNoRadio value={form.total_job_price_provided} onChange={(v) => set("total_job_price_provided", v)} />
          </Field>
          {form.total_job_price_provided === true && (
            <Field label="Total Job Price">
              <input type="number" inputMode="decimal" className={inputCls} value={form.total_job_price} onChange={(e) => set("total_job_price", e.target.value)} placeholder="0.00" />
            </Field>
          )}

          <Field label="Upgrade Sold / Accepted?">
            <YesNoRadio value={form.upgrade_sold_accepted} onChange={(v) => set("upgrade_sold_accepted", v)} />
          </Field>
          {form.upgrade_sold_accepted === true && (
            <Field label="Accepted Upgrade Amount">
              <input type="number" inputMode="decimal" className={inputCls} value={form.accepted_upgrade_amount} onChange={(e) => set("accepted_upgrade_amount", e.target.value)} placeholder="0.00" />
            </Field>
          )}

          <Field label="Final Contract Signed?">
            <YesNoRadio value={form.final_contract_signed} onChange={(v) => set("final_contract_signed", v)} />
          </Field>
          {form.final_contract_signed === true && (
            <Field label="Final Contract Date">
              <input type="date" className={inputCls} value={form.final_contract_date} onChange={(e) => set("final_contract_date", e.target.value)} />
            </Field>
          )}
        </Section>
      )}

      {isSale && !isInsurance && (
        <Section title="Sale Details">
          <Field label="Sale Amount" hint="Full job amount — stored once. Each rep's credit is derived from the split %.">
            <input type="number" inputMode="decimal" className={inputCls} value={form.sale_amount} onChange={(e) => set("sale_amount", e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Secondary Sales Rep" hint="Optional. Leave blank for a single-rep (100/0) sale.">
            <ComboSelect category="sales_rep" value={form.secondary_sales_rep} onChange={(v) => {
              set("secondary_sales_rep", v);
              if (v && !form.primary_rep_split_pct && !form.secondary_rep_split_pct) {
                set("primary_rep_split_pct", 50);
                set("secondary_rep_split_pct", 50);
              } else if (!v) { set("primary_rep_split_pct", 100); set("secondary_rep_split_pct", 0); }
            }} placeholder="None" />
          </Field>
          {String(form.secondary_sales_rep || "").trim() && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Primary Rep Split %">
                <input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={form.primary_rep_split_pct} onChange={(e) => set("primary_rep_split_pct", e.target.value)} placeholder="50" />
              </Field>
              <Field label="Secondary Rep Split %" hint={`Total must equal 100 (currently ${Number(form.primary_rep_split_pct || 0) + Number(form.secondary_rep_split_pct || 0)})`}>
                <input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={form.secondary_rep_split_pct} onChange={(e) => set("secondary_rep_split_pct", e.target.value)} placeholder="50" />
              </Field>
            </div>
          )}
          <Field label="Sale / Close Type">
            <ComboSelect category="sale_close_type" value={form.sale_close_type} onChange={(v) => set("sale_close_type", v)} placeholder="Select close type" />
          </Field>
          <Field label="Price #">
            <select className={inputCls} value={form.sale_price_number} onChange={(e) => set("sale_price_number", e.target.value)}>
              <option value="">Select…</option>
              <option value="Price 1">Price 1</option>
              <option value="Price 2">Price 2</option>
              <option value="Price 3">Price 3</option>
            </select>
          </Field>
          {isCancellation && (
            <Field label="Cancellation Reason">
              <ComboSelect category="cancellation_reason" value={form.cancellation_reason} onChange={(v) => set("cancellation_reason", v)} placeholder="Select reason" />
            </Field>
          )}
        </Section>
      )}

      {isDemoNoSale && !isInsurance && (
        <Section title="Demo No Sale — Rodney Webb Coaching">
          <Field label="Decision-Maker Status *" required hint="Two-Leg means all decision makers were present. If there is only one decision maker, select Two-Leg.">
            <ComboSelect category="decision_maker_status" value={form.decision_maker_status} onChange={(v) => set("decision_maker_status", v)} placeholder="Select…" />
          </Field>
          {showOneLegReason && (
            <Field label="If this was a one-leg presentation, why was a decision maker missing? *" required>
              <textarea className={inputCls + " min-h-20"} value={form.one_leg_reason} onChange={(e) => set("one_leg_reason", e.target.value)} />
            </Field>
          )}

          <Field label="What products did you present?">
            <CheckboxGroup options={PRODUCTS_PRESENTED} value={form.products_discussed} onChange={(v) => set("products_discussed", v)} />
          </Field>
          {form.products_discussed && form.products_discussed.split(", ").includes("Other") && (
            <Field label="Other products — details">
              <input className={inputCls} value={form.products_presented_other} onChange={(e) => set("products_presented_other", e.target.value)} />
            </Field>
          )}

          <Field label="What was the first price you gave? *" required>
            <input type="number" inputMode="decimal" className={inputCls} value={form.first_price_given} onChange={(e) => set("first_price_given", e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Did you give another price?">
            <YesNoRadio value={gaveSecondPrice} onChange={(v) => { setGaveSecondPrice(v); if (!v) set("price_2_given", ""); }} />
          </Field>
          {gaveSecondPrice && (
            <>
              <Field label="What was the second price?">
                <input type="number" inputMode="decimal" className={inputCls} value={form.price_2_given} onChange={(e) => set("price_2_given", e.target.value)} placeholder="0.00" />
              </Field>
              <Field label="Did you give a third price?">
                <YesNoRadio value={gaveThirdPrice} onChange={(v) => { setGaveThirdPrice(v); if (!v) set("price_3_given", ""); }} />
              </Field>
              {gaveThirdPrice && (
                <Field label="What was the third price?">
                  <input type="number" inputMode="decimal" className={inputCls} value={form.price_3_given} onChange={(e) => set("price_3_given", e.target.value)} placeholder="0.00" />
                </Field>
              )}
            </>
          )}

          <Field label="Did you offer financing?">
            <YesNoRadio value={form.financing_offered} onChange={(v) => set("financing_offered", v)} />
          </Field>
          {form.financing_offered === false && (
            <Field label="Why was financing not offered? *" required>
              <textarea className={inputCls + " min-h-20"} value={form.financing_not_offered_reason} onChange={(e) => set("financing_not_offered_reason", e.target.value)} />
            </Field>
          )}
          {form.financing_offered === true && (
            <>
              <Field label="What financing option or monthly payment did you present?">
                <input className={inputCls} value={form.financing_option_presented} onChange={(e) => set("financing_option_presented", e.target.value)} placeholder="e.g. 60 months at $189/mo" />
              </Field>
              <Field label="Financing Result" hint="Outcome/status of the financing application">
                <ComboSelect category="financing_result" value={form.financing_result} onChange={(v) => set("financing_result", v)} placeholder="Select…" />
              </Field>
            </>
          )}

          <Field label="What was the objection — the reason they did not buy?">
            <ComboSelect category="main_objection" value={form.main_objection} onChange={(v) => set("main_objection", v)} placeholder="Select objection" />
          </Field>
          <Field label="Exact customer wording (optional)">
            <textarea className={inputCls + " min-h-20"} value={form.objection_customer_wording} onChange={(e) => set("objection_customer_wording", e.target.value)} />
          </Field>

          <Field label="Step 7 result *" required>
            <select className={inputCls} value={form.step7_result} onChange={(e) => set("step7_result", e.target.value)}>
              <option value="">Select…</option>
              <option value="Positive / False Positive">Positive / False Positive</option>
              <option value="Negative">Negative</option>
            </select>
          </Field>
          {form.step7_result === "Positive / False Positive" && (
            <>
              <Field label="What exactly did the customer say to the closing question?">
                <textarea className={inputCls + " min-h-20"} value={form.closing_question_answer} onChange={(e) => set("closing_question_answer", e.target.value)} />
              </Field>
              <Field label="What did you say first?">
                <textarea className={inputCls + " min-h-20"} value={form.rep_response} onChange={(e) => set("rep_response", e.target.value)} />
              </Field>
              <Field label="What did you say next?">
                <textarea className={inputCls + " min-h-20"} value={form.rep_response_2} onChange={(e) => set("rep_response_2", e.target.value)} />
              </Field>
              <Field label="Walk-of-Life issues to review">
                <CheckboxGroup options={WALK_OF_LIFE} value={form.walk_of_life_issues} onChange={(v) => set("walk_of_life_issues", v)} />
              </Field>
              <Field label="Coaching notes (optional)">
                <textarea className={inputCls + " min-h-20"} value={form.step7_coaching_notes} onChange={(e) => set("step7_coaching_notes", e.target.value)} />
              </Field>
            </>
          )}
          {form.step7_result === "Negative" && (
            <>
              <Field label="How did you respond?">
                <textarea className={inputCls + " min-h-20"} value={form.rep_response} onChange={(e) => set("rep_response", e.target.value)} />
              </Field>
              <Field label="What exactly did the customer say in response to the transition questions (WDTS)?">
                <textarea className={inputCls + " min-h-20"} value={form.client_response_1} onChange={(e) => set("client_response_1", e.target.value)} />
              </Field>
              <Field label="Coaching follow-up">
                <CheckboxGroup options={STEP7_FOLLOWUP} value={form.step7_coaching_followup} onChange={(v) => set("step7_coaching_followup", v)} />
              </Field>
              <Field label="Things to review">
                <CheckboxGroup options={STEP7_THINGS} value={form.step7_things_to_review} onChange={(v) => set("step7_things_to_review", v)} />
              </Field>
              <Field label="Coaching notes (optional)">
                <textarea className={inputCls + " min-h-20"} value={form.step7_coaching_notes} onChange={(e) => set("step7_coaching_notes", e.target.value)} />
              </Field>
            </>
          )}
        </Section>
      )}

      {showResetSection && (
        <Section title="Reset">
          <Field label="Why did the appointment have to be reset? *" required>
            <textarea className={inputCls + " min-h-20"} value={form.reset_reason} onChange={(e) => set("reset_reason", e.target.value)} />
          </Field>
          <Field label="Were all decision makers present?" hint="Two-Leg = all decision makers present">
            <ComboSelect category="decision_maker_status" value={form.decision_maker_status} onChange={(v) => set("decision_maker_status", v)} placeholder="Select…" />
          </Field>
          {showOneLegReason && (
            <Field label="If One-Leg, what was the reason?">
              <input className={inputCls} value={form.one_leg_reason} onChange={(e) => set("one_leg_reason", e.target.value)} />
            </Field>
          )}
          <Field label="Was the follow-up/reset appointment scheduled? *" required>
            <YesNoRadio value={form.reset_appointment_scheduled} onChange={(v) => set("reset_appointment_scheduled", v)} />
          </Field>
          {form.reset_appointment_scheduled === true && (
            <Field label="When is the reset appointment?">
              <input type="date" className={inputCls} value={form.reset_date} onChange={(e) => set("reset_date", e.target.value)} />
            </Field>
          )}
          {form.reset_appointment_scheduled === false && (
            <Field label="What follow-up is needed? *" required>
              <textarea className={inputCls + " min-h-20"} value={form.reset_follow_up_notes} onChange={(e) => set("reset_follow_up_notes", e.target.value)} />
            </Field>
          )}
        </Section>
      )}

      <Section title="Follow-Up & Notes">
        <Toggle label="Follow-Up Needed?" value={form.follow_up_needed} onChange={(v) => set("follow_up_needed", v)} />
        {form.follow_up_needed === true && (
          <>
            <Field label="Follow-Up Bucket">
              <ComboSelect category="follow_up_bucket" value={form.follow_up_bucket} onChange={(v) => set("follow_up_bucket", v)} placeholder="Select bucket" />
            </Field>
            <Field label="Follow-Up Date">
              <input type="date" className={inputCls} value={form.follow_up_date} onChange={(e) => set("follow_up_date", e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Notes">
          <textarea className={inputCls + " min-h-24"} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </Field>
        <Field label="Submitted By *" required>
          <SubmittedBySelect value={form.submitted_by} onChange={(v) => set("submitted_by", v)} placeholder="Select name" />
        </Field>
      </Section>

      <button type="submit" disabled={submitting || !valid}
        className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-bold text-lg py-4 rounded-xl shadow-md flex items-center justify-center gap-2 transition-colors">
        {submitting ? <Loader2 className="w-5 h-5 animate-spin" /> : <CheckCircle2 className="w-5 h-5" />}
        {submitting ? "Submitting…" : "Submit Debrief"}
      </button>
      {!valid && <p className="text-center text-xs text-muted-foreground">Complete required (*) fields to submit.</p>}
    </form>
  );
}

const inputCls = "w-full border border-input rounded-lg px-3 py-3 text-base font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white";

function Section({ title, children }) {
  return (
    <div className="bg-white rounded-xl border border-border p-4 space-y-3 shadow-sm">
      <h2 className="font-heading font-bold text-sm text-primary uppercase tracking-wide">{title}</h2>
      {children}
    </div>
  );
}

function Field({ label, required, hint, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      {children}
    </label>
  );
}

function Toggle({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm font-semibold text-foreground">{label}</span>
      <button type="button" onClick={() => onChange(!value)}
        className={`relative w-12 h-7 rounded-full transition-colors ${value ? "bg-accent" : "bg-muted"}`}>
        <span className={`absolute top-0.5 left-0.5 w-6 h-6 bg-white rounded-full shadow transition-transform ${value ? "translate-x-5" : ""}`} />
      </button>
    </div>
  );
}

function YesNoRadio({ value, onChange }) {
  return (
    <div className="flex gap-2">
      {[true, false].map((v) => (
        <button type="button" key={String(v)} onClick={() => onChange(v)}
          className={`px-5 py-2.5 rounded-lg text-sm font-semibold border transition-colors ${value === v ? "bg-accent text-white border-accent" : "border-input bg-white text-foreground"}`}>
          {v ? "Yes" : "No"}
        </button>
      ))}
    </div>
  );
}

function CheckboxGroup({ options, value, onChange }) {
  const selected = (value || "").split(", ").filter(Boolean);
  function toggle(opt) {
    let next;
    if (selected.includes(opt)) next = selected.filter((s) => s !== opt);
    else next = [...selected, opt];
    onChange(next.join(", "));
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {options.map((opt) => (
        <label key={opt} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer ${selected.includes(opt) ? "bg-accent/10 border-accent" : "border-input bg-white"}`}>
          <input type="checkbox" checked={selected.includes(opt)} onChange={() => toggle(opt)} className="w-4 h-4 accent-accent" />
          <span className="font-medium text-foreground">{opt}</span>
        </label>
      ))}
    </div>
  );
}