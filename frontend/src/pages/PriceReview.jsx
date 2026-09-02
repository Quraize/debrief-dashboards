/**
 * Contract price review queue (admin).
 *
 * The scan reads recently signed jobs that have no Job Price, pulls their
 * accepted proposal PDFs from JobProgress, and has Claude classify each one
 * and extract the contract total. NOTHING is written back to JobProgress from
 * this page except through the Approve button — one candidate at a time, with
 * a live no-overwrite check on the other side.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, ScanSearch, BadgeDollarSign, ExternalLink, Check, X, Lock } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const money = (v) => "$" + Math.round(Number(v) || 0).toLocaleString();

function jpLink(row) {
  if (!row.customer_id || !row.jp_job_id) return null;
  return `https://app.jobprogress.com/#/customer-jobs/${row.customer_id}/job/${row.jp_job_id}/proposals`;
}

export default function PriceReview() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = !!user && user.role === "admin";

  const [days, setDays] = useState(5);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 15;

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ["price-candidates"],
    queryFn: () => base44.entities.JPPriceCandidate.list("-created_at").catch(() => []),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (user && user.role !== "admin") return <AccessDenied />;
  if (!user) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  const pending = candidates.filter((c) => c.status === "pending");
  // The audit trail: every job scanned and every document read, not only the
  // actionable ones. Filterable by outcome, paginated.
  const auditAll = candidates.filter((c) => c.status !== "pending");
  const audit = statusFilter === "all" ? auditAll : auditAll.filter((c) => c.status === statusFilter);
  const pageCount = Math.max(1, Math.ceil(audit.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const history = audit.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const statusCounts = auditAll.reduce((m, c) => ({ ...m, [c.status]: (m[c.status] ?? 0) + 1 }), {});

  async function runScan() {
    setScanning(true);
    try {
      const res = await base44.functions.invoke("scanContractPrices", { days: Number(days) || 5 });
      const r = res.data;
      toast({
        title: "Scan complete",
        description: `${r.jobs_scanned} job(s) checked, ${r.proposals_examined} document(s) read, ${r.candidates_created} result(s).`,
      });
      qc.invalidateQueries({ queryKey: ["price-candidates"] });
    } catch (err) {
      toast({ title: "Scan failed", description: err.message, variant: "destructive" });
    } finally {
      setScanning(false);
    }
  }

  async function approve(row) {
    setBusyId(row.id);
    try {
      const res = await base44.functions.invoke("approveContractPrice", { candidate_id: row.id });
      toast(res.data.applied
        ? { title: "Price applied", description: `${money(res.data.amount)} written to job ${row.job_number || row.jp_job_id} in JobProgress.` }
        : { title: "Nothing written", description: res.data.reason });
      qc.invalidateQueries({ queryKey: ["price-candidates"] });
    } catch (err) {
      toast({ title: "Approve failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function reject(row) {
    setBusyId(row.id);
    try {
      await base44.functions.invoke("rejectContractPrice", { candidate_id: row.id });
      toast({ title: "Rejected", description: "No price was written." });
      qc.invalidateQueries({ queryKey: ["price-candidates"] });
    } catch (err) {
      toast({ title: "Reject failed", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="bg-primary rounded-lg w-10 h-10 flex items-center justify-center">
          <BadgeDollarSign className="w-5 h-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Contract Price Review</h1>
          <p className="text-sm text-muted-foreground">
            AI finds documents accepted in JobProgress recently, checks whether their job has a Job Price,
            and reads the contract when it doesn't. You approve; only then is JobProgress updated.
          </p>
        </div>
      </div>

      {/* Scan controls */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap items-end gap-3">
        <div>
          <label className="text-xs font-semibold text-muted-foreground block mb-1">Look back (days)</label>
          <input type="number" min="1" max="60" value={days} onChange={(e) => setDays(e.target.value)}
            className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white w-24" />
        </div>
        <button onClick={runScan} disabled={scanning}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
          {scanning ? <Loader2 className="w-4 h-4 animate-spin" /> : <ScanSearch className="w-4 h-4" />}
          Scan Recent Contracts
        </button>
        <p className="text-xs text-muted-foreground basis-full">
          Finds documents accepted in the last N days across all jobs (insurance excluded), straight from
          JobProgress. Reads documents only — never writes a price. Documents already examined are skipped.
        </p>
      </div>

      {/* Pending review */}
      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
      ) : pending.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Nothing waiting for review. Run a scan, or come back after the next signed job.
        </div>
      ) : pending.map((row) => (
        <div key={row.id} className={`bg-white rounded-xl border p-4 shadow-sm ${row.confidence === "low" ? "border-amber-300" : "border-border"}`}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <div className="text-xs text-muted-foreground">Job</div>
              <div className="font-semibold">{row.job_number || row.jp_job_id}</div>
              <div className="text-xs text-muted-foreground">{row.job_name}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Signed</div>
              <div className="font-medium">{row.contract_signed_date || "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Document</div>
              <div className="font-medium">{row.proposal_title || row.proposal_file_name}</div>
            </div>
            <div className="ml-auto text-right">
              <div className="text-xs text-muted-foreground">Extracted Job Price</div>
              <div className="text-2xl font-heading font-bold text-primary">{money(row.extracted_amount)}</div>
              <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${row.confidence === "high" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                {row.confidence === "high" ? "High confidence" : "Check carefully"}
              </span>
            </div>
          </div>

          {row.extraction_notes && (
            <div className="mt-2 text-xs bg-amber-50 border border-amber-200 rounded-lg p-2 text-amber-900">
              {row.extraction_notes}
            </div>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button disabled={busyId === row.id}
                  className="bg-green-700 text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                  {busyId === row.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  Approve {money(row.extracted_amount)}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Write this price to JobProgress?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Job {row.job_number || row.jp_job_id} ({row.job_name}) — Job Price will be set to{" "}
                    <span className="font-bold">{money(row.extracted_amount)}</span>. If a price has been
                    entered manually since the scan, nothing is overwritten.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => approve(row)}>Write to JobProgress</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <button onClick={() => reject(row)} disabled={busyId === row.id}
              className="bg-white border border-border rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
              <X className="w-4 h-4" /> Reject
            </button>

            {jpLink(row) && (
              <a href={jpLink(row)} target="_blank" rel="noreferrer"
                className="text-sm text-sky-700 font-medium flex items-center gap-1 ml-auto">
                Open document in JobProgress <ExternalLink className="w-3.5 h-3.5" />
              </a>
            )}
          </div>
        </div>
      ))}

      {/* Audit trail — everything the automation has looked at */}
      {auditAll.length > 0 && (
        <div className="bg-white rounded-xl border border-border shadow-sm">
          <div className="flex flex-wrap items-center gap-2 p-4 pb-2">
            <h2 className="font-heading font-bold text-sm text-primary mr-2">Everything Reviewed</h2>
            {["all", "applied", "skipped", "rejected", "failed"].map((s) => (
              <button key={s} onClick={() => { setStatusFilter(s); setPage(0); }}
                className={`text-xs px-2.5 py-1 rounded-full font-semibold ${statusFilter === s ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground"}`}>
                {s === "all" ? `All (${auditAll.length})` : `${s} (${statusCounts[s] ?? 0})`}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2">Job</th>
                  <th className="px-4 py-2">Document</th>
                  <th className="px-4 py-2">Classified As</th>
                  <th className="px-4 py-2">Amount</th>
                  <th className="px-4 py-2">Outcome</th>
                  <th className="px-4 py-2">By</th>
                  <th className="px-4 py-2">Notes</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-b border-border/50 align-top">
                    <td className="px-4 py-2 whitespace-nowrap">{r.job_number || r.jp_job_id}</td>
                    <td className="px-4 py-2">{r.proposal_id === "none" ? <span className="text-muted-foreground italic">no documents</span> : (r.proposal_title || r.proposal_file_name)}</td>
                    <td className="px-4 py-2">{r.classification || "—"}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{r.extracted_amount ? money(r.extracted_amount) : "—"}</td>
                    <td className={`px-4 py-2 font-semibold ${r.status === "applied" ? "text-green-700" : r.status === "failed" ? "text-red-600" : "text-muted-foreground"}`}>{r.status}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground whitespace-nowrap">{r.reviewed_by || "—"}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground max-w-xs">{r.extraction_notes || r.apply_error || ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pageCount > 1 && (
            <div className="flex items-center justify-between p-3 border-t border-border text-sm">
              <button onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}
                className="px-3 py-1.5 rounded-lg border border-border font-semibold disabled:opacity-40">← Prev</button>
              <span className="text-muted-foreground text-xs">
                Page {safePage + 1} of {pageCount} · {audit.length} record(s)
              </span>
              <button onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))} disabled={safePage >= pageCount - 1}
                className="px-3 py-1.5 rounded-lg border border-border font-semibold disabled:opacity-40">Next →</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function AccessDenied() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Lock className="w-12 h-12 text-muted-foreground mb-3" />
      <h1 className="text-xl font-heading font-bold text-primary">Admin Access Required</h1>
      <p className="text-sm text-muted-foreground mt-1">You do not have permission to view this page.</p>
    </div>
  );
}
