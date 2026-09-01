import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { X, Loader2, Save } from "lucide-react";
import ComboSelect from "@/components/ComboSelect";
import {
  APPOINTMENT_OUTCOMES, DECISION_MAKER_STATUS, SALE_CLOSE_TYPES, TRADES,
  INSURANCE_OUTCOMES, RESET_STATUSES, FOLLOW_UP_BUCKETS
} from "@allied/shared/constants";
import { normalizeAppointmentType } from "@allied/shared/appointmentTypes";

const inputCls = "w-full border border-input rounded-lg px-3 py-2.5 text-base font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white";

// Editable fields for the Edit Debrief modal. Booleans use a tri-state select so null is preserved.
const NUM_FIELDS = ["first_price_given","price_2_given","price_3_given","prices_given","sale_amount","primary_rep_split_pct","secondary_rep_split_pct"];
const BOOL_FIELDS = ["financing_offered","reset_needed","reset_appointment_scheduled","follow_up_needed","contingency_signed","demo_completed"];

function fromDebrief(d) {
  const f = {};
  [
    "customer_name","phone","address","city","crm_lead_id","appointment_date","marketing_source","referral_source",
    "sales_rep","appointment_setter","product","business_division","trade","appointment_type",
    "appointment_outcome","decision_maker_status","one_leg_reason","sales_appointment","non_sales_reason",
    "products_discussed","products_presented_other","additional_prices_given",
    "financing_not_offered_reason","financing_option_presented","financing_result",
    "sale_close_type","sale_signed_date","sale_date","sale_price_number",
    "secondary_sales_rep",
    "main_objection","objection_customer_wording",
    "reset_status","reset_date","reset_reason","reset_follow_up_notes",
    "follow_up_bucket","follow_up_date",
    "insurance_outcome","contingency_signed_date","final_contract_date",
    "notes"
  ].forEach((k) => { f[k] = d[k] != null ? d[k] : ""; });
  NUM_FIELDS.forEach((k) => { f[k] = d[k] != null && d[k] !== "" ? String(d[k]) : ""; });
  BOOL_FIELDS.forEach((k) => {
    f[k] = d[k] === true ? "true" : d[k] === false ? "false" : "";
  });
  // Normalize appointment type for display (New Appointment -> First Appointment, Re-engagement -> Rehash).
  f.appointment_type = normalizeAppointmentType(f.appointment_type || "");
  return f;
}

export default function EditDebriefModal({ debrief, onClose }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const [form, setForm] = useState({});
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (debrief) setForm(fromDebrief(debrief)); }, [debrief]);

  if (!debrief) return null;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const isInsurance = form.product === "Insurance" || form.business_division === "Insurance";

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = { ...form };
      NUM_FIELDS.forEach((k) => { payload[k] = payload[k] !== "" ? Number(payload[k]) : undefined; });
      BOOL_FIELDS.forEach((k) => {
        payload[k] = payload[k] === "true" ? true : payload[k] === "false" ? false : undefined;
      });
      payload.last_edited_at = new Date().toISOString();
      payload.last_edited_by = me?.full_name || "manager";
      payload.edit_reason = editReason.trim() || "Edit Debrief";
      await base44.entities.Debrief.update(debrief.id, payload);
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      qc.invalidateQueries({ queryKey: ["debriefs-all"] });
      toast({ title: "Debrief updated", description: `${debrief.customer_name} saved.` });
      onClose();
    } catch (err) {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-2xl rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[94vh] overflow-y-auto">
        <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-3 border-b border-border z-10">
          <h2 className="font-heading font-bold text-base text-primary">Edit Debrief — {debrief.customer_name}</h2>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        <form onSubmit={handleSave} className="p-4 space-y-4">
          <Section title="Client & Appointment">
            <Field label="Customer Name"><input className={inputCls} value={form.customer_name || ""} onChange={(e) => set("customer_name", e.target.value)} /></Field>
            <Field label="Phone"><input className={inputCls} value={form.phone || ""} onChange={(e) => set("phone", e.target.value)} /></Field>
            <Field label="Street Address"><input className={inputCls} value={form.address || ""} onChange={(e) => set("address", e.target.value)} /></Field>
            <Field label="City"><input className={inputCls} value={form.city || ""} onChange={(e) => set("city", e.target.value)} /></Field>
            <Field label="Lead ID / JobProgress ID"><input className={inputCls} value={form.crm_lead_id || ""} onChange={(e) => set("crm_lead_id", e.target.value)} /></Field>
            <Field label="Appointment Date"><input type="date" className={inputCls} value={form.appointment_date || ""} onChange={(e) => set("appointment_date", e.target.value)} /></Field>
            <Field label="Marketing Source"><ComboSelect category="marketing_source" value={form.marketing_source || ""} onChange={(v) => set("marketing_source", v)} /></Field>
            <Field label="Referral Source"><ComboSelect category="referral_source" value={form.referral_source || ""} onChange={(v) => set("referral_source", v)} /></Field>
          </Section>

          <Section title="Rep & Division">
            <Field label="Sales Rep"><ComboSelect category="sales_rep" value={form.sales_rep || ""} onChange={(v) => set("sales_rep", v)} /></Field>
            <Field label="Appointment Setter"><ComboSelect category="appointment_setter" value={form.appointment_setter || ""} onChange={(v) => set("appointment_setter", v)} /></Field>
            <Field label="Division"><ComboSelect category="product" value={form.product || ""} onChange={(v) => set("product", v)} /></Field>
            <Field label="Appointment Type"><ComboSelect category="appointment_type" value={form.appointment_type || ""} onChange={(v) => set("appointment_type", v)} normalizeValue={normalizeAppointmentType} /></Field>
            {isInsurance && (
              <Field label="Trade">
                <select className={inputCls} value={form.trade || ""} onChange={(e) => set("trade", e.target.value)}>
                  <option value="">Select…</option>{TRADES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
            )}
          </Section>

          <Section title="Result">
            <Field label="Appointment Outcome">
              <select className={inputCls} value={form.appointment_outcome || ""} onChange={(e) => set("appointment_outcome", e.target.value)}>
                <option value="">Select…</option>{APPOINTMENT_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="Decision Maker Status">
              <select className={inputCls} value={form.decision_maker_status || ""} onChange={(e) => set("decision_maker_status", e.target.value)}>
                <option value="">Select…</option>{DECISION_MAKER_STATUS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </Field>
            <Field label="One-Leg Reason"><input className={inputCls} value={form.one_leg_reason || ""} onChange={(e) => set("one_leg_reason", e.target.value)} /></Field>
            <Field label="Sales Appointment?"><input className={inputCls} value={form.sales_appointment || ""} onChange={(e) => set("sales_appointment", e.target.value)} placeholder="Yes / No" /></Field>
            <Field label="Non-Sales Reason"><input className={inputCls} value={form.non_sales_reason || ""} onChange={(e) => set("non_sales_reason", e.target.value)} /></Field>
          </Section>

          <Section title="Presentation & Pricing">
            <Field label="Products Discussed"><input className={inputCls} value={form.products_discussed || ""} onChange={(e) => set("products_discussed", e.target.value)} /></Field>
            <Field label="Price 1 Given"><input type="number" inputMode="decimal" className={inputCls} value={form.first_price_given || ""} onChange={(e) => set("first_price_given", e.target.value)} /></Field>
            <Field label="Price 2 Given"><input type="number" inputMode="decimal" className={inputCls} value={form.price_2_given || ""} onChange={(e) => set("price_2_given", e.target.value)} /></Field>
            <Field label="Price 3 Given"><input type="number" inputMode="decimal" className={inputCls} value={form.price_3_given || ""} onChange={(e) => set("price_3_given", e.target.value)} /></Field>
            <Field label="Prices Given Count"><input type="number" inputMode="decimal" className={inputCls} value={form.prices_given || ""} onChange={(e) => set("prices_given", e.target.value)} /></Field>
            <Field label="Financing Offered">
              <select className={inputCls} value={form.financing_offered || ""} onChange={(e) => set("financing_offered", e.target.value)}>
                <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
              </select>
            </Field>
            <Field label="Financing Not Offered Reason"><input className={inputCls} value={form.financing_not_offered_reason || ""} onChange={(e) => set("financing_not_offered_reason", e.target.value)} /></Field>
            <Field label="Financing Option Presented"><input className={inputCls} value={form.financing_option_presented || ""} onChange={(e) => set("financing_option_presented", e.target.value)} /></Field>
            <Field label="Financing Result"><ComboSelect category="financing_result" value={form.financing_result || ""} onChange={(v) => set("financing_result", v)} /></Field>
          </Section>

          <Section title="Sale">
            <Field label="Sale Amount ($)<br /><span className='text-xs text-muted-foreground'>Full job amount — stored once. Signed-month attribution uses Sale Signed Date</span>">
              <input type="number" inputMode="decimal" className={inputCls} value={form.sale_amount || ""} onChange={(e) => set("sale_amount", e.target.value)} />
            </Field>
            <Field label="Secondary Sales Rep"><ComboSelect category="sales_rep" value={form.secondary_sales_rep || ""} onChange={(v) => {
              set("secondary_sales_rep", v);
              if (v && !form.primary_rep_split_pct && !form.secondary_rep_split_pct) { set("primary_rep_split_pct", "50"); set("secondary_rep_split_pct", "50"); }
              else if (!v) { set("primary_rep_split_pct", "100"); set("secondary_rep_split_pct", "0"); }
            }} /></Field>
            <Field label="Primary Rep Split %"><input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={form.primary_rep_split_pct || ""} onChange={(e) => set("primary_rep_split_pct", e.target.value)} /></Field>
            <Field label="Secondary Rep Split %"><input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={form.secondary_rep_split_pct || ""} onChange={(e) => set("secondary_rep_split_pct", e.target.value)} /></Field>
            <Field label="Sale Signed Date"><input type="date" className={inputCls} value={form.sale_signed_date || ""} onChange={(e) => set("sale_signed_date", e.target.value)} /></Field>
            <Field label="Sale / Close Type">
              <select className={inputCls} value={form.sale_close_type || ""} onChange={(e) => set("sale_close_type", e.target.value)}>
                <option value="">Select…</option>{SALE_CLOSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Sale Date"><input type="date" className={inputCls} value={form.sale_date || ""} onChange={(e) => set("sale_date", e.target.value)} /></Field>
            <Field label="Sale Price #"><input className={inputCls} value={form.sale_price_number || ""} onChange={(e) => set("sale_price_number", e.target.value)} /></Field>
            <Field label="Main Objection"><ComboSelect category="main_objection" value={form.main_objection || ""} onChange={(v) => set("main_objection", v)} /></Field>
            <Field label="Objection — Customer Wording"><textarea className={inputCls + " min-h-16"} value={form.objection_customer_wording || ""} onChange={(e) => set("objection_customer_wording", e.target.value)} /></Field>
          </Section>

          <Section title="Reset & Follow-Up">
            <Field label="Reset Needed?">
              <select className={inputCls} value={form.reset_needed || ""} onChange={(e) => set("reset_needed", e.target.value)}>
                <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
              </select>
            </Field>
            <Field label="Reset Status">
              <select className={inputCls} value={form.reset_status || ""} onChange={(e) => set("reset_status", e.target.value)}>
                <option value="">Select…</option>{RESET_STATUSES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Reset Date"><input type="date" className={inputCls} value={form.reset_date || ""} onChange={(e) => set("reset_date", e.target.value)} /></Field>
            <Field label="Reset Reason"><textarea className={inputCls + " min-h-16"} value={form.reset_reason || ""} onChange={(e) => set("reset_reason", e.target.value)} /></Field>
            <Field label="Reset Appointment Scheduled?">
              <select className={inputCls} value={form.reset_appointment_scheduled || ""} onChange={(e) => set("reset_appointment_scheduled", e.target.value)}>
                <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
              </select>
            </Field>
            <Field label="Reset Follow-Up Notes"><textarea className={inputCls + " min-h-16"} value={form.reset_follow_up_notes || ""} onChange={(e) => set("reset_follow_up_notes", e.target.value)} /></Field>
            <Field label="Follow-Up Needed?">
              <select className={inputCls} value={form.follow_up_needed || ""} onChange={(e) => set("follow_up_needed", e.target.value)}>
                <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
              </select>
            </Field>
            <Field label="Follow-Up Bucket">
              <select className={inputCls} value={form.follow_up_bucket || ""} onChange={(e) => set("follow_up_bucket", e.target.value)}>
                <option value="">Select…</option>{FOLLOW_UP_BUCKETS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Follow-Up Date"><input type="date" className={inputCls} value={form.follow_up_date || ""} onChange={(e) => set("follow_up_date", e.target.value)} /></Field>
          </Section>

          {isInsurance && (
            <Section title="Insurance">
              <Field label="Insurance Outcome">
                <select className={inputCls} value={form.insurance_outcome || ""} onChange={(e) => set("insurance_outcome", e.target.value)}>
                  <option value="">Select…</option>{INSURANCE_OUTCOMES.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="Contingency Signed?">
                <select className={inputCls} value={form.contingency_signed || ""} onChange={(e) => set("contingency_signed", e.target.value)}>
                  <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              </Field>
              <Field label="Contingency Signed Date"><input type="date" className={inputCls} value={form.contingency_signed_date || ""} onChange={(e) => set("contingency_signed_date", e.target.value)} /></Field>
              <Field label="Demo Completed?">
                <select className={inputCls} value={form.demo_completed || ""} onChange={(e) => set("demo_completed", e.target.value)}>
                  <option value="">Unset</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              </Field>
              <Field label="Final Contract Date"><input type="date" className={inputCls} value={form.final_contract_date || ""} onChange={(e) => set("final_contract_date", e.target.value)} /></Field>
            </Section>
          )}

          <Section title="Notes & Audit">
            <Field label="Notes"><textarea className={inputCls + " min-h-24"} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} /></Field>
            <Field label="Edit Reason (audit)"><input className={inputCls} value={editReason} onChange={(e) => setEditReason(e.target.value)} placeholder="What was corrected?" /></Field>
          </Section>

          <div className="sticky bottom-0 bg-white border-t border-border pt-3 pb-2">
            <button type="submit" disabled={saving}
              className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
              {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="bg-white border border-border rounded-xl p-3 space-y-2">
      <h3 className="text-xs font-heading font-bold text-primary uppercase tracking-wide">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">{children}</div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-semibold text-foreground" dangerouslySetInnerHTML={{ __html: label }} />
      {children}
    </label>
  );
}