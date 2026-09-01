import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Plus, Trash2, Check, Settings2, X } from "lucide-react";
import { LIST_CATEGORIES } from "@allied/shared/constants";

export default function AdminSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data: users = [] } = useQuery({ queryKey: ["users"], queryFn: () => base44.entities.User.list().catch(() => []) });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Admin Settings</h1>
        <p className="text-sm text-muted-foreground">Manage dropdown lists — add, edit, deactivate, or delete options.</p>
      </div>

      {LIST_CATEGORIES.map((cat) => (
        <ListManager key={cat.key} category={cat.key} label={cat.label} qc={qc} toast={toast} />
      ))}

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
        <h2 className="font-heading font-bold text-sm text-primary mb-3">Users / Reps ({users.length})</h2>
        {users.length === 0 ? (
          <p className="text-sm text-muted-foreground">No users. Invite team members from the platform Users panel.</p>
        ) : (
          <div className="space-y-1">
            {users.map((u) => (
              <div key={u.id} className="flex items-center justify-between py-2 border-b border-border/60 last:border-0">
                <div>
                  <div className="font-semibold text-sm text-primary">{u.full_name || u.email}</div>
                  <div className="text-xs text-muted-foreground capitalize">{u.role?.replace(/_/g, " ")}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ListManager({ category, label, qc, toast }) {
  const [newValue, setNewValue] = useState("");
  const [editId, setEditId] = useState(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);

  const { data: options = [], isLoading } = useQuery({
    queryKey: ["list-options", category],
    queryFn: () => base44.entities.ListOption.filter({ category })
  });

  async function addOption() {
    const v = newValue.trim();
    if (!v) return;
    setSaving(true);
    try {
      await base44.entities.ListOption.create({ category, value: v, active: true });
      qc.invalidateQueries({ queryKey: ["list-options", category] });
      setNewValue("");
      toast({ title: "Added", description: `"${v}" added to ${label}.` });
    } catch (err) {
      toast({ title: "Failed", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  async function toggleActive(opt) {
    await base44.entities.ListOption.update(opt.id, { active: !opt.active });
    qc.invalidateQueries({ queryKey: ["list-options", category] });
  }

  async function deleteOption(opt) {
    await base44.entities.ListOption.delete(opt.id);
    qc.invalidateQueries({ queryKey: ["list-options", category] });
  }

  async function saveEdit(opt) {
    const v = editVal.trim();
    if (!v) return;
    setSaving(true);
    try {
      await base44.entities.ListOption.update(opt.id, { value: v });
      qc.invalidateQueries({ queryKey: ["list-options", category] });
      setEditId(null);
    } finally { setSaving(false); }
  }

  return (
    <div className="bg-white rounded-xl border border-border p-4 shadow-sm">
      <h2 className="font-heading font-bold text-sm text-primary mb-3">{label} ({options.length})</h2>

      <div className="flex gap-1 mb-3">
        <input className={ic} placeholder="Add new option…" value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addOption(); } }} />
        <button onClick={addOption} disabled={saving || !newValue.trim()}
          className="shrink-0 bg-accent disabled:opacity-50 text-white rounded-lg px-3 flex items-center justify-center">
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
        </button>
      </div>

      {isLoading ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : (
        <div className="space-y-1">
          {options.map((o) => (
            <div key={o.id} className="flex items-center gap-1 py-1 border-b border-border/40 last:border-0">
              {editId === o.id ? (
                <>
                  <input className="flex-1 border border-input rounded px-2 py-1 text-sm bg-white"
                    value={editVal} onChange={(e) => setEditVal(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); saveEdit(o); } }} autoFocus />
                  <button onClick={() => saveEdit(o)} disabled={saving}>
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4 text-green-600" />}
                  </button>
                  <button onClick={() => setEditId(null)}><X className="w-4 h-4 text-muted-foreground" /></button>
                </>
              ) : (
                <>
                  <span className={`flex-1 text-sm font-medium ${o.active === false ? "line-through text-muted-foreground" : "text-foreground"}`}>{o.value}</span>
                  <button onClick={() => toggleActive(o)}
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${o.active !== false ? "bg-green-100 text-green-700" : "bg-secondary text-muted-foreground"}`}>
                    {o.active !== false ? "Active" : "Off"}
                  </button>
                  <button onClick={() => { setEditId(o.id); setEditVal(o.value); }}>
                    <Settings2 className="w-3.5 h-3.5 text-muted-foreground hover:text-foreground" />
                  </button>
                  <button onClick={() => deleteOption(o)}>
                    <Trash2 className="w-3.5 h-3.5 text-red-500 hover:text-red-600" />
                  </button>
                </>
              )}
            </div>
          ))}
          {options.length === 0 && <p className="text-xs text-muted-foreground text-center py-2">No options yet — add one above.</p>}
        </div>
      )}
    </div>
  );
}

const ic = "flex-1 border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white";