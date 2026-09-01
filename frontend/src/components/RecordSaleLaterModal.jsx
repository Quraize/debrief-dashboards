import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { X, Loader2, DollarSign } from "lucide-react";
import { SALE_CLOSE_TYPES } from "@allied/shared/constants";
import ComboSelect from "@/components/ComboSelect";

const inputCls = "w-full border border-input rounded-lg px-3 py-2.5 text-base font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white";

// Compact modal to record a sale that closed after the original appointment.
// Updates the SAME Debrief by internal id — never creates a new record.
// Leaves appointment_date, appointment_type, decision_maker_status, and appointment_outcome untouched.
export default function RecordSaleLaterModal({ debrief, onClose }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });

  const [saleSignedDate, setSaleSignedDate] = useState("");
  const [saleAmount, setSaleAmount] = useState("");
  const [closeType, setCloseType] = useState("Sale After Follow-Up");
  const [saleNotes, setSaleNotes] = useState("");
  const [secondaryRep, setSecondaryRep] = useState("");
  const [primarySplit, setPrimarySplit] = useState("");
  const [secondarySplit, setSecondarySplit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (debrief) {
      setSaleSignedDate(debrief.sale_signed_date || "");
      setSaleAmount(debrief.sale_amount != null && debrief.sale_amount !== "" ? String(debrief.sale_amount) : "");
      setCloseType(debrief.sale_close_type || "Sale After Follow-Up");
      setSaleNotes("");
      setSecondaryRep(debrief.secondary_sales_rep || "");
      setPrimarySplit(debrief.primary_rep_split_pct != null ? String(debrief.primary_rep_split_pct) : "");
      setSecondarySplit(debrief.secondary_rep_split_pct != null ? String(debrief.secondary_rep_split_pct) : "");
    }
  }, [debrief]);

  if (!debrief) return null;

  // Split validation: if secondary rep is set, primary + secondary must total 100.
  const hasSec = !!(secondaryRep && secondaryRep.trim());
  const pNum = Number(primarySplit) || 0;
  const sNum = Number(secondarySplit) || 0;
  const splitValid = !hasSec || (pNum + sNum === 100 && pNum >= 0 && sNum >= 0);
  const valid = saleSignedDate && saleAmount && Number(saleAmount) > 0 && splitValid;

  function handleSecondaryRepChange(v) {
    setSecondaryRep(v);
    if (v && !primarySplit && !secondarySplit) { setPrimarySplit("50"); setSecondarySplit("50"); }
    else if (!v) { setPrimarySplit("100"); setSecondarySplit("0"); }
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!valid) return;
    setSaving(true);
    try {
      const stamp = new Date().toISOString();
      const note = saleNotes.trim()
        ? `[Later Sale — ${saleSignedDate} — $${Number(saleAmount).toLocaleString()}] ${saleNotes.trim()}`
        : `[Later Sale recorded — ${saleSignedDate} — $${Number(saleAmount).toLocaleString()}]`;
      const existingNotes = debrief.notes ? debrief.notes + "\n" : "";
      const update = {
        sale_signed_date: saleSignedDate,
        sale_amount: Number(saleAmount),
        sale_close_type: closeType,
        notes: existingNotes + note,
        last_edited_at: stamp,
        last_edited_by: me?.full_name || "manager",
        edit_reason: "Record Sale Later",
      };
      // Split-sale fields — only write when a secondary rep is set.
      if (hasSec) {
        update.secondary_sales_rep = secondaryRep.trim();
        update.primary_rep_split_pct = pNum;
        update.secondary_rep_split_pct = sNum;
      } else {
        update.secondary_sales_rep = "";
        update.primary_rep_split_pct = 100;
        update.secondary_rep_split_pct = 0;
      }
      await base44.entities.Debrief.update(debrief.id, update);
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      qc.invalidateQueries({ queryKey: ["debriefs-all"] });
      toast({ title: "Later sale recorded", description: `${debrief.customer_name} — $${Number(saleAmount).toLocaleString()} on ${saleSignedDate}.` });
      onClose();
    } catch (err) {
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="sticky top-0 bg-white flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-accent" />
            <h2 className="font-heading font-bold text-base text-primary">Record Sale Later</h2>
          </div>
          <button onClick={onClose} aria-label="Close"><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>
        <form onSubmit={handleSave} className="p-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            For <strong className="text-foreground">{debrief.customer_name}</strong> — appointment {debrief.appointment_date || "—"}. The original visit result, date, and two-leg answer stay unchanged.
          </p>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">Sale Signed Date *</span>
            <input type="date" className={inputCls} value={saleSignedDate} onChange={(e) => setSaleSignedDate(e.target.value)} required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">Sale Amount * ($)</span>
            <input type="number" inputMode="decimal" className={inputCls} value={saleAmount} onChange={(e) => setSaleAmount(e.target.value)} placeholder="0.00" required />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">Sale / Close Type</span>
            <select className={inputCls} value={closeType} onChange={(e) => setCloseType(e.target.value)}>
              {SALE_CLOSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="border-t border-border pt-3 space-y-3">
            <p className="text-xs font-semibold text-foreground">Split-Sale Credits (optional)</p>
            <label className="block space-y-1">
              <span className="text-sm font-semibold text-foreground">Secondary Sales Rep</span>
              <ComboSelect category="sales_rep" value={secondaryRep} onChange={handleSecondaryRepChange} />
            </label>
            {hasSec && (
              <div className="grid grid-cols-2 gap-2">
                <label className="block space-y-1">
                  <span className="text-sm font-semibold text-foreground">Primary Split %</span>
                  <input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={primarySplit} onChange={(e) => setPrimarySplit(e.target.value)} />
                </label>
                <label className="block space-y-1">
                  <span className="text-sm font-semibold text-foreground">Secondary Split %</span>
                  <input type="number" inputMode="numeric" min="0" max="100" className={inputCls} value={secondarySplit} onChange={(e) => setSecondarySplit(e.target.value)} />
                </label>
              </div>
            )}
            {hasSec && !splitValid && <p className="text-xs text-red-600 font-semibold">Primary + Secondary must total 100.</p>}
          </div>
          <label className="block space-y-1">
            <span className="text-sm font-semibold text-foreground">Sale Notes (optional)</span>
            <textarea className={inputCls + " min-h-20"} value={saleNotes} onChange={(e) => setSaleNotes(e.target.value)} placeholder="Products, terms, or context for this later sale…" />
          </label>
          <button type="submit" disabled={saving || !valid}
            className="w-full bg-accent hover:bg-accent/90 disabled:opacity-50 text-white font-bold py-3 rounded-lg flex items-center justify-center gap-2">
            {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : <DollarSign className="w-5 h-5" />}
            {saving ? "Saving…" : "Record Sale"}
          </button>
          {!valid && <p className="text-center text-xs text-muted-foreground">Signed date and a positive amount are required{hasSec ? "; split must total 100." : "."}</p>}
        </form>
      </div>
    </div>
  );
}