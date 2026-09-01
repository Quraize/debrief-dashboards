import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, Play, GitMerge, Shield, Clock, Info, Lock, AlertCircle, History, DatabaseBackup } from "lucide-react";
import SyncResultCards from "@/components/SyncResultCards";
import SyncExceptionsPanel from "@/components/SyncExceptionsPanel";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

export default function JobProgressSync() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = !!user && user.role === "admin";

  const today = new Date();
  const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000);
  const [dateFrom, setDateFrom] = useState(fmtDate(thirtyDaysAgo));
  const [dateTo, setDateTo] = useState(fmtDate(today));
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [backfillFrom, setBackfillFrom] = useState("2026-01-01");
  const [backfillTo, setBackfillTo] = useState(fmtDate(today));
  const [backfillQueued, setBackfillQueued] = useState(null);

  const { data: lastCommits = [] } = useQuery({
    queryKey: ["last-commit"],
    queryFn: () => base44.entities.SyncRun.filter({ mode: "commit", status: "completed" }, "-finished_at", 1).catch(() => []),
    enabled: isAdmin,
  });

  // Schedule state and backfill progress, from the scheduler itself. Polled
  // while the page is open so a running backfill's progress bar moves.
  const { data: syncStatus } = useQuery({
    queryKey: ["sync-status"],
    queryFn: () => base44.functions.invoke("getSyncStatus", {}).then((r) => r.data).catch(() => null),
    enabled: isAdmin,
    refetchInterval: 30_000,
  });

  const { data: recentRuns = [] } = useQuery({
    queryKey: ["sync-runs"],
    queryFn: () => base44.entities.SyncRun.list("-started_at").catch(() => []),
    enabled: isAdmin,
    refetchInterval: 30_000,
  });

  // Admin access control (after all hooks)
  if (user && user.role !== "admin") {
    return <AccessDenied />;
  }
  if (!user) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  const lastCommit = lastCommits[0];

  async function runDryRun() {
    setRunning(true);
    setError(null);
    try {
      const res = await base44.functions.invoke("syncLeapJobProgress", {
        mode: "dry_run",
        date_from: dateFrom,
        date_to: dateTo,
      });
      setResult(res.data);
      toast({ title: "Dry run complete", description: "No records were modified." });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
    } catch (err) {
      setError(err.message || "Dry run failed");
      toast({ title: "Dry run failed", description: err.message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  async function runCommit() {
    setRunning(true);
    try {
      const res = await base44.functions.invoke("syncLeapJobProgress", {
        mode: "commit",
        date_from: dateFrom,
        date_to: dateTo,
      });
      setResult(res.data);
      toast({ title: "Commit complete", description: "Sync applied successfully." });
      qc.invalidateQueries({ queryKey: ["last-commit"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
    } catch (err) {
      toast({ title: "Commit failed", description: err.message, variant: "destructive" });
    } finally {
      setRunning(false);
    }
  }

  async function queueBackfill(mode) {
    try {
      const res = await base44.functions.invoke("backfillJobProgress", {
        mode, date_from: backfillFrom, date_to: backfillTo,
      });
      setBackfillQueued(res.data);
      toast({
        title: "Backfill queued",
        description: `${res.data.chunks} monthly chunk(s), ${mode === "commit" ? "writing records" : "dry run"}. Progress appears below as each chunk completes.`,
      });
      qc.invalidateQueries({ queryKey: ["sync-status"] });
      qc.invalidateQueries({ queryKey: ["sync-runs"] });
    } catch (err) {
      toast({ title: "Backfill not queued", description: err.message, variant: "destructive" });
    }
  }

  const counts = result?.counts;
  const summary = counts ? {
    new: counts.proposed_new_appointments ?? 0,
    updates: counts.proposed_updates ?? 0,
    excluded: counts.excluded_unmatched_candidates ?? 0,
  } : null;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="bg-primary rounded-lg w-10 h-10 flex items-center justify-center">
          <Shield className="w-5 h-5 text-primary-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">JobProgress Sync</h1>
          <p className="text-sm text-muted-foreground">Read-only sync with JobProgress/Leap CRM. Admin access required.</p>
        </div>
      </div>

      {/* Status bar */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-semibold">Last Successful Commit:</span>
          <span className="text-sm text-muted-foreground">
            {lastCommit?.finished_at ? new Date(lastCommit.finished_at).toLocaleString() : "Never"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Schedule:</span>
          {syncStatus?.schedule ? (
            syncStatus.schedule.enabled ? (
              <span className="text-sm text-green-700 font-medium" title={`cron "${syncStatus.schedule.cron}" (UTC)`}>
                Active — 4×/day (UTC)
              </span>
            ) : (
              <span className="text-sm text-muted-foreground" title={`Would run cron "${syncStatus.schedule.cron}" (UTC). Set SYNC_SCHEDULE_ENABLED=true after a clean manual commit run.`}>
                Disabled
              </span>
            )
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </div>
        {syncStatus?.lastScheduledRun && (
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Last Scheduled Run:</span>
            <span className={`text-sm ${syncStatus.lastScheduledRun.status === "completed" ? "text-muted-foreground" : "text-red-600"}`}>
              {new Date(syncStatus.lastScheduledRun.started_at).toLocaleString()} ({syncStatus.lastScheduledRun.status})
            </span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">Status:</span>
          {running ? (
            <span className="text-sm text-accent flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Running…</span>
          ) : error ? (
            <span className="text-sm text-red-600 flex items-center gap-1"><AlertCircle className="w-3 h-3" /> Failed</span>
          ) : result ? (
            <span className="text-sm text-green-600">Completed (no writes)</span>
          ) : (
            <span className="text-sm text-muted-foreground">Ready</span>
          )}
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Date From</label>
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Date To</label>
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={runDryRun} disabled={running || !dateFrom || !dateTo}
            className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run Dry Run
          </button>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button disabled={running || !dateFrom || !dateTo}
                className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                <GitMerge className="w-4 h-4" />
                Commit Sync
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Commit Sync</AlertDialogTitle>
                <AlertDialogDescription>
                  This will apply changes to your records. Based on the last dry run for this date range:
                  {summary ? (
                    <span className="block mt-2 font-semibold text-foreground">
                      <br />• Proposed new appointments: {summary.new}
                      <br />• Proposed updates: {summary.updates}
                      <br />• Excluded non-sales: {summary.excluded}
                    </span>
                  ) : (
                    <span className="block mt-2">Run a dry run first to see a summary of changes.</span>
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={runCommit}>Confirm Commit</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Historical backfill */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2">
          <DatabaseBackup className="w-4 h-4 text-primary" />
          <h2 className="font-heading font-bold text-sm text-primary">Historical Backfill</h2>
        </div>
        <p className="text-xs text-muted-foreground">
          Sweeps the range month by month through the queue (not this browser request), one Sync Run
          per chunk. Safe to re-trigger after a failure — completed chunks are skipped, and re-running
          a chunk cannot create duplicates.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">From</label>
            <input type="date" value={backfillFrom} onChange={(e) => setBackfillFrom(e.target.value)}
              className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" />
          </div>
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">To</label>
            <input type="date" value={backfillTo} onChange={(e) => setBackfillTo(e.target.value)}
              className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white" />
          </div>
          <button onClick={() => queueBackfill("dry_run")} disabled={syncStatus?.backfill?.active}
            className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            <Play className="w-4 h-4" /> Queue Dry-Run Backfill
          </button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button disabled={syncStatus?.backfill?.active}
                className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
                <GitMerge className="w-4 h-4" /> Queue Commit Backfill
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Confirm Commit Backfill</AlertDialogTitle>
                <AlertDialogDescription>
                  This writes records for {backfillFrom} → {backfillTo}, one month at a time.
                  Re-runs are idempotent, but a commit is still a commit — consider a dry-run
                  backfill first if this range has never been swept.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => queueBackfill("commit")}>Queue Backfill</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        {syncStatus?.backfill?.active && (
          <div className="text-sm bg-sky-50 border border-sky-200 rounded-lg p-3">
            <span className="font-semibold text-sky-900">
              Backfill in progress ({syncStatus.backfill.mode}): {syncStatus.backfill.dateFrom} → {syncStatus.backfill.dateTo}
            </span>
            {syncStatus.backfill.progress && (
              <span className="text-sky-800"> — {syncStatus.backfill.progress.completed} of {syncStatus.backfill.progress.total} chunks complete</span>
            )}
          </div>
        )}
        {!syncStatus?.backfill?.active && backfillQueued && (
          <div className="text-xs text-muted-foreground">
            Last queued: {backfillQueued.chunks} chunk(s) ({backfillQueued.mode}).
          </div>
        )}
      </div>

      {/* Results */}
      {error && (
        <div className="bg-red-50 border border-red-300 rounded-xl p-4 text-sm text-red-700">{error}</div>
      )}
      {counts && <SyncResultCards counts={counts} />}

      {/* Recent runs — the first UI to read sync_run.counts off the rows */}
      {recentRuns.length > 0 && (
        <div className="bg-white rounded-xl border border-border shadow-sm">
          <div className="flex items-center gap-2 p-4 pb-2">
            <History className="w-4 h-4 text-primary" />
            <h2 className="font-heading font-bold text-sm text-primary">Recent Sync Runs</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2">Started</th>
                  <th className="px-4 py-2">Mode</th>
                  <th className="px-4 py-2">Window</th>
                  <th className="px-4 py-2">Type</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Examined</th>
                  <th className="px-4 py-2">Created</th>
                  <th className="px-4 py-2">Updated</th>
                  <th className="px-4 py-2">By</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.slice(0, 12).map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="px-4 py-2 whitespace-nowrap">{r.started_at ? new Date(r.started_at).toLocaleString() : "—"}</td>
                    <td className="px-4 py-2">{r.mode}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{r.date_from} → {r.date_to}</td>
                    <td className="px-4 py-2">{r.full_backfill ? "backfill" : "incremental"}</td>
                    <td className={`px-4 py-2 font-semibold ${r.status === "completed" ? "text-green-700" : r.status === "running" ? "text-sky-700" : "text-red-600"}`}>{r.status}</td>
                    <td className="px-4 py-2">{r.counts?.api_appointments_examined ?? 0}</td>
                    <td className="px-4 py-2">{r.counts?.created ?? 0}</td>
                    <td className="px-4 py-2">{r.counts?.updated ?? 0}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.started_by || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Attribution explanation */}
      <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 flex gap-2">
        <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
        <div className="text-xs text-blue-900 space-y-1">
          <div><strong>Sales &amp; Revenue</strong> use Contract Signed Date for signed-month attribution.</div>
          <div><strong>Appointment KPIs</strong> (demos, two-leg) use appointment date.</div>
          <div><strong>Two-leg eligibility</strong> applies only to Residential Install Roofing, Siding, and Roofing+Siding appointments.</div>
        </div>
      </div>

      {/* Exceptions */}
      <SyncExceptionsPanel />
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