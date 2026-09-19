/**
 * Phone system (Intermedia Unite) — admin.
 *
 * Phase 0 of the call-recordings project: prove the connection. The test
 * signs in to each Unite API with the platform's service account and reports
 * what is on the other side — users, yesterday's calls, one user's recordings.
 * It stores nothing and shows no full phone numbers.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { Phone, Loader2, PlugZap, CheckCircle2, XCircle, Lock, RefreshCw } from "lucide-react";

export default function UniteCalls() {
  const { user } = useAuth();
  const { toast } = useToast();
  const isAdmin = !!user && user.role === "admin";
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);
  const qc = useQueryClient();

  async function syncNow() {
    setSyncing(true);
    try {
      const res = await base44.functions.invoke("syncUniteCalls", {});
      setSyncResult(res.data);
      qc.invalidateQueries({ queryKey: ["unite-status"] });
      toast({ title: "Calls synced", description: `${res.data.counts.calls_upserted} call(s) stored, ${res.data.counts.calls_matched_now} matched to a lead on this run.` });
    } catch (err) {
      toast({ title: "Call sync failed", description: err.message, variant: "destructive" });
    } finally {
      setSyncing(false);
    }
  }

  const { data: status } = useQuery({
    queryKey: ["unite-status"],
    queryFn: () => base44.functions.invoke("getUniteStatus", {}).then((r) => r.data).catch(() => null),
    enabled: isAdmin,
  });

  if (user && !isAdmin) return <AccessDenied />;
  if (!user) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;

  async function probe() {
    setProbing(true);
    try {
      const res = await base44.functions.invoke("testUniteConnection", {});
      setResult(res.data);
      const failed = (res.data.steps ?? []).filter((s) => !s.ok).length;
      toast(failed ? { title: `${failed} check(s) failed`, description: "See the details below.", variant: "destructive" } : { title: "Unite connection works", description: "Every API answered." });
    } catch (err) {
      toast({ title: "Connection test failed", description: err.message, variant: "destructive" });
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="bg-primary rounded-lg w-10 h-10 flex items-center justify-center"><Phone className="w-5 h-5 text-primary-foreground" /></div>
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Phone System — Intermedia Unite</h1>
          <p className="text-sm text-muted-foreground">Call recordings and transcripts into the debrief platform. Phase 1: every outside call, matched to its lead.</p>
        </div>
      </div>

      {/* The mirror: what the platform holds, and the sync that fills it. */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2"><RefreshCw className="w-4 h-4 text-primary" /><h2 className="font-heading font-bold text-sm text-primary">Call mirror</h2></div>
        {status?.mirror ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
              <Card label="Extensions" value={String(status.mirror.users)} lines={["people and lines on Unite"]} />
              <Card label="Outside calls stored" value={String(status.mirror.calls)}
                lines={[status.mirror.oldest ? `since ${new Date(status.mirror.oldest).toLocaleDateString()}` : "none yet", status.mirror.newest ? `newest ${new Date(status.mirror.newest).toLocaleString()}` : ""].filter(Boolean)} />
              <Card label="Matched to a lead" value={status.mirror.calls ? `${Math.round((status.mirror.matched / status.mirror.calls) * 100)}%` : "—"}
                lines={[`${status.mirror.matched} call(s) · ${status.mirror.customersWithCalls} lead(s)`, "by the customer's phone number in JobProgress"]} />
              <Card label="Schedule" value={status.schedule?.enabled ? "every 15 min" : "off"}
                lines={[status.schedule?.enabled ? "re-reads the last 48 hours each run" : status.schedule?.reason || "", status.mirror.lastRun ? `last run ${new Date(status.mirror.lastRun.started_at).toLocaleString()} (${status.mirror.lastRun.status})` : "never run"].filter(Boolean)} />
            </div>
            {status.mirror.lastRun?.error_message && <p className="text-xs text-red-700">Last run failed: {status.mirror.lastRun.error_message}</p>}
          </>
        ) : <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={syncNow} disabled={syncing || !status?.configured}
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {syncing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Sync calls now
          </button>
          <span className="text-xs text-muted-foreground">Users, then every outside call of the last 48 hours, then matching to leads. Internal extension-to-extension calls are not kept.</span>
        </div>
        {syncResult && (
          <p className="text-xs text-muted-foreground">
            Last manual run: {syncResult.counts.calls_examined} call(s) read · {syncResult.counts.calls_upserted} stored · {syncResult.counts.calls_internal_skipped} internal skipped ·
            {" "}{syncResult.counts.calls_without_number} with no usable number · {syncResult.counts.calls_matched_now} matched on this run · {syncResult.counts.calls_unmatched_total} still unmatched overall.
          </p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <div><span className="font-semibold">Credentials:</span>{" "}
            {status == null ? <span className="text-muted-foreground">checking…</span>
              : status.configured ? <span className="text-green-700 font-medium">service account on file</span>
              : <span className="text-red-600">{status.reason}</span>}
          </div>
          {status?.apiBase && <div><span className="font-semibold">API:</span> <span className="font-mono text-xs">{status.apiBase}</span></div>}
        </div>
        <p className="text-xs text-muted-foreground">
          The test signs in to each Unite API with the platform's service account and reports what it can see: the account's users, yesterday's
          calls, and whether one user's recordings can be listed. Nothing is stored; phone numbers are masked. Run it after Intermedia confirms the
          account's API access, and again any time something stops working.
        </p>
        <button onClick={probe} disabled={probing || !status?.configured}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
          {probing ? <Loader2 className="w-4 h-4 animate-spin" /> : <PlugZap className="w-4 h-4" />} Test the connection
        </button>

        {result && (
          <div className="space-y-3 pt-2 border-t border-border">
            <ul className="space-y-1 text-sm">
              {result.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-2">
                  {s.ok ? <CheckCircle2 className="w-4 h-4 text-green-600 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 text-red-600 mt-0.5 shrink-0" />}
                  <div><span className="font-semibold">{s.name}</span> <span className={s.ok ? "text-muted-foreground" : "text-red-700"}>— {s.detail}</span></div>
                </li>
              ))}
            </ul>
            <div className="grid sm:grid-cols-3 gap-3 text-sm">
              <Card label="Users with an extension" value={`${result.users.withExtension} of ${result.users.total}`}
                lines={result.users.sample.map((u) => `${u.name}${u.extension ? ` · ext ${u.extension}` : ""}`)} />
              <Card label={`Calls on ${result.calls.window}`} value={String(result.calls.total)}
                lines={[`${result.calls.inbound} inbound · ${result.calls.outbound} outbound · ${result.calls.internal} internal`, `${result.calls.matchableNumbers} with an outside number we could match to a lead`]} />
              <Card label="Recordings" value={result.recordings.listed == null ? "—" : String(result.recordings.listed)}
                lines={[result.recordings.user ? `for ${result.recordings.user}` : "no user tested", result.recordings.newest ? `newest ${new Date(result.recordings.newest).toLocaleString()}` : "",
                  result.autoAttendant?.user ? `${result.autoAttendant.user}: ${result.autoAttendant.listed == null ? "error" : `${result.autoAttendant.listed} listed`}` : ""].filter(Boolean)} />
            </div>
            <div className={`rounded-xl border p-3 text-sm ${result.audio?.ok ? "border-green-200 bg-green-50 text-green-900" : result.audio?.tried ? "border-red-200 bg-red-50 text-red-900" : "border-border bg-secondary/40"}`}>
              <div className="text-[11px] uppercase tracking-wide font-semibold opacity-80">Can we download the audio?</div>
              <div className="font-semibold mt-0.5">{result.audio?.ok ? "Yes" : result.audio?.tried ? "No" : "Not tested"} <span className="font-normal opacity-80">— {result.audio?.detail}</span></div>
              <div className="text-xs mt-1 opacity-80">This decides Phases 2 and 3: if the audio downloads, we can transcribe calls ourselves without the Contact Center add-on.</div>
            </div>
            <div className="hidden">
            </div>
            {result.calls.sample.length > 0 && (
              <div className="overflow-x-auto border border-border rounded-lg">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-muted-foreground bg-secondary/50"><th className="px-3 py-1.5">Start (UTC)</th><th className="px-3 py-1.5">Direction</th><th className="px-3 py-1.5">From</th><th className="px-3 py-1.5">To</th><th className="px-3 py-1.5 text-right">Seconds</th></tr></thead>
                  <tbody>{result.calls.sample.map((c, i) => (
                    <tr key={i} className="border-t border-border/50"><td className="px-3 py-1.5 whitespace-nowrap">{c.start}</td><td className="px-3 py-1.5">{c.direction}</td><td className="px-3 py-1.5">{c.from}</td><td className="px-3 py-1.5">{c.to}</td><td className="px-3 py-1.5 text-right tabular-nums">{c.seconds}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Card({ label, value, lines }) {
  return (
    <div className="rounded-xl border border-border p-3">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</div>
      <div className="text-2xl font-heading font-bold text-primary mt-0.5">{value}</div>
      {lines.map((l, i) => <div key={i} className="text-xs text-muted-foreground mt-0.5">{l}</div>)}
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
