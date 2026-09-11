import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { get, post, qs } from "@/api/http";
import { useToast } from "@/components/ui/use-toast";
import { canApprove, APPROVAL_LABELS } from "@allied/shared/debriefApproval";
import { DQ_NO_DEMO_OUTCOME } from "@allied/shared/constants";
import { usDate } from "@/lib/format";
import { CheckCircle2, XCircle, Loader2, ShieldCheck, ChevronLeft, ChevronRight } from "lucide-react";

const STATUS_TABS = [["pending", "Awaiting approval"], ["approved", "Approved"], ["rejected", "Rejected"], ["all", "All"]];
const TONE = { pending: "bg-amber-100 text-amber-800", approved: "bg-green-100 text-green-800", rejected: "bg-red-100 text-red-800" };

/**
 * Manager sign-off for "No Demo — DQ / Do Not Reset" debriefs. A rep who
 * disqualifies a lead instead of resetting it takes that opportunity off the
 * board; until a manager approves, the debrief is kept out of every result.
 */
export default function DebriefApprovals() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => base44.auth.me().catch(() => null) });
  const allowed = !!me && canApprove(me.role);

  const [status, setStatus] = useState("pending");
  const [page, setPage] = useState(1);
  const [notes, setNotes] = useState({}); // per-row note drafts

  const { data, isLoading, error } = useQuery({
    queryKey: ["debrief-approvals", status, page],
    queryFn: () => get(`/api/debriefs/approvals${qs({ status, page, limit: 25 })}`),
    enabled: allowed, staleTime: 15_000,
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }) => post(`/api/debriefs/${id}/approval`, { decision, note: notes[id] || "" }),
    onSuccess: (r, { decision }) => {
      qc.invalidateQueries({ queryKey: ["debrief-approvals"] });
      qc.invalidateQueries({ queryKey: ["debriefs"] });
      toast({ title: decision === "approve" ? "Approved" : "Rejected", description: `${r.data.customer_name} — ${usDate(r.data.appointment_date)} by ${r.data.approved_by_name}.` });
    },
    onError: (err) => toast({ title: "Could not save the decision", description: err.message, variant: "destructive" }),
  });

  if (me && !allowed) return <div className="py-20 text-center text-muted-foreground">Manager access required (admin, sales manager or project manager).</div>;

  const counts = data?.counts ?? {};
  const rows = data?.rows ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary flex items-center gap-2"><ShieldCheck className="w-6 h-6" /> Debrief Approvals</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">
          Every debrief filed with the outcome <strong>{DQ_NO_DEMO_OUTCOME}</strong>. The rep went, gave no demo and disqualified the lead
          rather than resetting it. A manager confirms each one; until then the debrief stays out of the dashboards, Results Review and
          the Manager Report. The Open Debrief Queue treats it as filed from the moment it is submitted.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {["pending", "approved", "rejected"].map((s) => (
          <button key={s} onClick={() => { setStatus(s); setPage(1); }}
            className={`text-left rounded-xl border p-4 shadow-sm transition-colors ${status === s ? "bg-primary text-primary-foreground border-primary" : "bg-white border-border hover:bg-secondary"}`}>
            <div className={`text-[11px] uppercase tracking-wide font-semibold ${status === s ? "text-primary-foreground/80" : "text-muted-foreground"}`}>{APPROVAL_LABELS[s]}</div>
            <div className="text-2xl font-heading font-bold mt-1">{counts[s] ?? "—"}</div>
          </button>
        ))}
      </div>

      <div className="bg-white rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 p-3 border-b border-border">
          {STATUS_TABS.map(([s, label]) => (
            <button key={s} onClick={() => { setStatus(s); setPage(1); }}
              className={`px-3 py-1 rounded-full text-xs font-semibold border ${status === s ? "bg-primary text-primary-foreground border-primary" : "bg-white border-border hover:bg-secondary"}`}>{label}</button>
          ))}
          {data && <span className="ml-auto text-xs text-muted-foreground">{data.total} debrief{data.total === 1 ? "" : "s"}</span>}
        </div>

        {error && <div className="p-4 text-sm text-red-700">{error.message}</div>}
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">Nothing here.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-max">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border bg-secondary/40">
                  <th className="px-3 py-2">Appointment</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">Rep</th>
                  <th className="px-3 py-2">Setter</th>
                  <th className="px-3 py-2">Why disqualified</th>
                  <th className="px-3 py-2">Filed by</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Decided by</th>
                  <th className="px-3 py-2">Decision</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{usDate(r.appointment_date)}<div className="text-xs text-muted-foreground">{r.appointment_type || ""}</div></td>
                    <td className="px-3 py-2 whitespace-nowrap font-semibold text-primary">{r.customer_name}<div className="text-xs text-muted-foreground font-normal">{r.city || ""}{r.crm_lead_id ? ` · ${r.crm_lead_id}` : ""}</div></td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.sales_rep}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{r.appointment_setter}</td>
                    <td className="px-3 py-2 max-w-sm whitespace-pre-wrap">{r.dq_reason || <span className="text-muted-foreground">—</span>}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">{r.submitted_by}<div className="text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</div></td>
                    <td className="px-3 py-2 whitespace-nowrap"><span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${TONE[r.approval_status]}`}>{APPROVAL_LABELS[r.approval_status] ?? r.approval_status}</span></td>
                    <td className="px-3 py-2 whitespace-nowrap text-xs">
                      {r.approved_by_name ? <>{r.approved_by_name}<div className="text-muted-foreground">{new Date(r.approved_at).toLocaleString()}</div>{r.approval_note && <div className="text-muted-foreground italic max-w-xs whitespace-pre-wrap">"{r.approval_note}"</div>}</> : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2">
                      {r.approval_status === "pending" ? (
                        <div className="flex flex-col gap-1.5 min-w-56">
                          <input value={notes[r.id] || ""} onChange={(e) => setNotes((n) => ({ ...n, [r.id]: e.target.value }))} placeholder="Note to the rep (optional)"
                            className="border border-input rounded-lg px-2 py-1 text-xs bg-white" />
                          <div className="flex gap-1.5">
                            <button onClick={() => decide.mutate({ id: r.id, decision: "approve" })} disabled={decide.isPending}
                              className="flex items-center gap-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold px-2.5 py-1.5 rounded-lg"><CheckCircle2 className="w-3.5 h-3.5" /> Approve</button>
                            <button onClick={() => decide.mutate({ id: r.id, decision: "reject" })} disabled={decide.isPending}
                              className="flex items-center gap-1 bg-white border border-red-300 text-red-700 hover:bg-red-50 disabled:opacity-50 text-xs font-semibold px-2.5 py-1.5 rounded-lg"><XCircle className="w-3.5 h-3.5" /> Reject</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => decide.mutate({ id: r.id, decision: r.approval_status === "approved" ? "reject" : "approve" })} disabled={decide.isPending}
                          className="text-xs text-accent underline">{r.approval_status === "approved" ? "Change to rejected" : "Change to approved"}</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pages > 1 && (
          <div className="flex items-center justify-between px-3 py-2 border-t border-border text-xs text-muted-foreground">
            <span>Page {data.page} of {data.pages}</span>
            <div className="flex gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1} className="p-1 rounded border border-border disabled:opacity-40"><ChevronLeft className="w-4 h-4" /></button>
              <button onClick={() => setPage((p) => Math.min(data.pages, p + 1))} disabled={page >= data.pages} className="p-1 rounded border border-border disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
