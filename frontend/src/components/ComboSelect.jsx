import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { Plus, Trash2, Pencil, Check, X, Settings2, Loader2 } from "lucide-react";

const selectCls = "flex-1 border border-input rounded-lg px-3 py-3 text-base font-medium focus:outline-none focus:ring-2 focus:ring-accent bg-white";

export default function ComboSelect({ category, value, onChange, placeholder = "Select…", normalizeValue }) {
  const qc = useQueryClient();
  const [manage, setManage] = useState(false);
  const [newValue, setNewValue] = useState("");
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: options = [] } = useQuery({
    queryKey: ["list-options", category],
    queryFn: () => base44.entities.ListOption.filter({ category })
  });

  const activeOptions = options.filter((o) => o.active !== false);
  // When a normalizeValue fn is provided (e.g. appointment_type), map raw option values
  // through it and de-duplicate so legacy variants (New Appointment, Re-engagement) never
  // appear as separate selectable labels.
  const seen = new Set();
  const allValues = [];
  activeOptions.forEach((o) => {
    const v = normalizeValue ? normalizeValue(o.value) : o.value;
    if (!seen.has(v)) { seen.add(v); allValues.push(v); }
  });
  const displayValue = normalizeValue && value ? normalizeValue(value) : value;
  const showFallback = displayValue && !allValues.includes(displayValue);

  async function addOption() {
    const v = newValue.trim();
    if (!v) return;
    setSaving(true);
    try {
      await base44.entities.ListOption.create({ category, value: v, active: true });
      qc.invalidateQueries({ queryKey: ["list-options", category] });
      setNewValue("");
      onChange(v);
    } finally { setSaving(false); }
  }

  async function deleteOption(opt) {
    await base44.entities.ListOption.delete(opt.id);
    qc.invalidateQueries({ queryKey: ["list-options", category] });
    if (value === opt.value) onChange("");
  }

  async function saveEdit(opt) {
    const v = editVal.trim();
    if (!v) return;
    setSaving(true);
    try {
      await base44.entities.ListOption.update(opt.id, { value: v });
      qc.invalidateQueries({ queryKey: ["list-options", category] });
      if (value === opt.value) onChange(v);
      setEditId(null);
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-1">
        <select className={selectCls} value={displayValue || ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">{placeholder}</option>
          {showFallback && <option value={displayValue}>{displayValue}</option>}
          {allValues.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <button type="button" onClick={() => setManage(!manage)}
          className="shrink-0 w-12 border border-input rounded-lg flex items-center justify-center bg-white hover:bg-secondary transition-colors"
          aria-label="Manage options">
          {manage ? <X className="w-4 h-4 text-muted-foreground" /> : <Settings2 className="w-4 h-4 text-muted-foreground" />}
        </button>
      </div>

      {manage && (
        <div className="bg-secondary/30 rounded-lg p-2 space-y-1.5 border border-border">
          <div className="flex gap-1">
            <input className="flex-1 border border-input rounded-lg px-2 py-2 text-sm font-medium bg-white"
              placeholder="Add new…" value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }} />
            <button type="button" onClick={addOption} disabled={saving || !newValue.trim()}
              className="shrink-0 bg-accent disabled:opacity-50 text-white rounded-lg px-3 flex items-center justify-center">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </button>
          </div>

          {activeOptions.length === 0 && <p className="text-xs text-muted-foreground text-center py-1">No options yet.</p>}

          {activeOptions.map((o) => (
            <div key={o.id} className="flex items-center gap-1 py-0.5">
              {editId === o.id ? (
                <>
                  <input className="flex-1 border border-input rounded px-2 py-1 text-sm bg-white"
                    value={editVal} onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(o); } }} autoFocus />
                  <button type="button" onClick={() => saveEdit(o)} disabled={saving}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-green-600" />}
                  </button>
                  <button type="button" onClick={() => setEditId(null)}><X className="w-4 h-4 text-muted-foreground" /></button>
                </>
              ) : (
                <>
                  <span className="flex-1 text-sm font-medium truncate">{o.value}</span>
                  <button type="button" onClick={() => { setEditId(o.id); setEditVal(o.value); }}>
                    <Pencil className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                  <button type="button" onClick={() => deleteOption(o)}>
                    <Trash2 className="w-3.5 h-3.5 text-red-500 hover:text-red-600" />
                  </button>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}