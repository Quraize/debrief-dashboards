/**
 * Debrief Reminders (admin): who receives the two-hour "debrief missing"
 * emails, whether the job is on, what is due right now, a test send, and the
 * log of what went out.
 */
import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { base44 } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { BellRing, Loader2, Lock, Send, Play, Save, Check, AlertTriangle, History, Mail } from "lucide-react";
import { usDate, simpleTime } from "@/lib/format";

const nameKey = (s) => String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const fmtWhen = (iso) => { if (!iso) return "—"; const d = new Date(iso); return `${usDate(d.toISOString())} ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`; };

export default function DebriefReminders() {
  const { user } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = !!user && user.role === "admin";

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ["reminder-status"],
    queryFn: () => base44.functions.invoke("getReminderStatus", {}).then((r) => r.data),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });
  const { data: recipients = [] } = useQuery({
    queryKey: ["reminder-recipients"],
    queryFn: () => base44.entities.DebriefReminderRecipient.list("rep_name"),
    enabled: isAdmin,
  });
  const { data: log = [] } = useQuery({
    queryKey: ["reminder-log"],
    queryFn: () => base44.entities.DebriefReminder.list("-created_at"),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [preview, setPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [sendingNow, setSendingNow] = useState(false);

  // One row per rep name: the CRM names seen recently, merged with saved recipients
  // (so a saved rep who has no recent appointments still shows).
  const rows = useMemo(() => {
    const byKey = new Map();
    for (const r of recipients) byKey.set(nameKey(r.rep_name), { key: nameKey(r.rep_name), rep_name: r.rep_name, recipient: r, appointments: 0, last_seen: null });
    for (const n of status?.repNames ?? []) {
      const k = nameKey(n.rep_name);
      const row = byKey.get(k) ?? { key: k, rep_name: n.rep_name, recipient: null, appointments: 0, last_seen: null };
      row.appointments = n.appointments; row.last_seen = n.last_seen;
      byKey.set(k, row);
    }
    const unmatched = new Set((status?.unmatchedReps ?? []).map(nameKey));
    return [...byKey.values()]
      .map((r) => ({ ...r, dueUnmatched: unmatched.has(r.key) }))
      .sort((a, b) => (b.dueUnmatched ? 1 : 0) - (a.dueUnmatched ? 1 : 0) || b.appointments - a.appointments || a.rep_name.localeCompare(b.rep_name));
  }, [recipients, status]);

  if (user && !isAdmin) return <AccessDenied />;
  if (!user) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;

  async function sendTest() {
    setTesting(true);
    try {
      const res = await base44.functions.invoke("sendTestReminderEmail", { to: testTo.trim() });
      toast({ title: "Test email sent", description: `"${res.data.subject}" was accepted by the mail server for ${testTo.trim()}.` });
      qc.invalidateQueries({ queryKey: ["reminder-log"] });
    } catch (err) {
      toast({ title: "Test email failed", description: err.message, variant: "destructive" });
    } finally { setTesting(false); }
  }

  async function previewDue() {
    setPreviewing(true);
    try {
      const res = await base44.functions.invoke("runDebriefReminders", { dry_run: true });
      setPreview(res.data);
    } catch (err) {
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    } finally { setPreviewing(false); }
  }

  async function sendNow() {
    setSendingNow(true);
    try {
      const res = await base44.functions.invoke("runDebriefReminders", { dry_run: false });
      const d = res.data;
      toast({
        title: d.status === "completed" ? "Reminders sent" : d.status === "quiet_hours" ? "Quiet hours — nothing sent" : "Email not configured",
        description: d.status === "completed" ? `${d.sent} sent, ${d.failed} failed, ${d.noRecipient} without a recipient.` : undefined,
      });
      setPreview(d);
      qc.invalidateQueries({ queryKey: ["reminder-log"] });
      qc.invalidateQueries({ queryKey: ["reminder-status"] });
    } catch (err) {
      toast({ title: "Run failed", description: err.message, variant: "destructive" });
    } finally { setSendingNow(false); }
  }

  const s = status;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="bg-primary rounded-lg w-10 h-10 flex items-center justify-center"><BellRing className="w-5 h-5 text-primary-foreground" /></div>
        <div>
          <h1 className="text-2xl font-heading font-bold text-primary">Debrief Reminders</h1>
          <p className="text-sm text-muted-foreground">
            Two hours after a sales appointment starts with no debrief filed, the rep gets one email. Admin access required.
          </p>
        </div>
      </div>

      {/* Status */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-2">
        {statusLoading || !s ? <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /> : (
          <>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div><span className="font-semibold">Schedule:</span>{" "}
                {s.enabled
                  ? <span className="text-green-700 font-medium" title={`cron "${s.cron}" (UTC)`}>Active — every 15 min</span>
                  : <span className="text-muted-foreground" title={`Would run cron "${s.cron}" (UTC)`}>Disabled ({s.reason})</span>}
              </div>
              <div><span className="font-semibold">Mail:</span>{" "}
                {s.mail.configured
                  ? <span className="text-green-700 font-medium">{s.mail.from || s.mail.user} via {s.mail.host}:{s.mail.port}</span>
                  : <span className="text-red-600">{s.mail.reason}</span>}
              </div>
              <div><span className="font-semibold">Quiet hours:</span> {clock(s.settings.quietStartHour)} – {clock(s.settings.quietEndHour)} Eastern{s.quietHoursNow ? <span className="text-amber-700 font-medium"> (now)</span> : ""}</div>
              <div><span className="font-semibold">Last run:</span> {s.lastRun ? `${fmtWhen(s.lastRun.completed_on)} (${s.lastRun.state})` : "never"}</div>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <div><span className="font-semibold">Due now:</span> <span className={s.dueNow > 0 ? "font-bold text-primary" : "text-muted-foreground"}>{s.dueNow}</span>
                {s.dueWithoutRecipient > 0 && <span className="text-amber-700"> ({s.dueWithoutRecipient} without a recipient)</span>}
              </div>
              <div><span className="font-semibold">Last 7 days:</span> {s.last7Days.sent} sent{s.last7Days.failed ? <span className="text-red-600">, {s.last7Days.failed} failed</span> : ""}</div>
              <div className="text-xs text-muted-foreground">
                Rule: {s.settings.delayHours}h after start · looks back {s.settings.lookbackDays} days
                {s.settings.startDate ? <> · <span className="font-semibold text-foreground">appointments from {usDate(s.settings.startDate)} onward only</span></> : ""}
                {" "}· max {s.settings.perRunLimit} per run · links to {s.settings.baseUrl}
              </div>
            </div>
            {!s.enabled && s.mail.configured && (
              <p className="text-xs text-muted-foreground">To turn the schedule on, set <code>DEBRIEF_REMINDERS_ENABLED=true</code> in the server's env file and release. Until then you can still send a test and run manually below.</p>
            )}
          </>
        )}
      </div>

      {/* Test + manual run */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2"><Mail className="w-4 h-4 text-primary" /><h2 className="font-heading font-bold text-sm text-primary">Test &amp; run</h2></div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs font-semibold text-muted-foreground block mb-1">Send a test email to</label>
            <input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} placeholder="you@alliednj.com"
              className="border border-input rounded-lg px-3 py-2 text-sm font-medium bg-white w-72" />
          </div>
          <button onClick={sendTest} disabled={testing || !EMAIL_RE.test(testTo.trim()) || !s?.mail?.configured}
            className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {testing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send test
          </button>
          <span className="flex-1" />
          <button onClick={previewDue} disabled={previewing}
            className="bg-white border border-border rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {previewing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Preview what is due
          </button>
          <button onClick={sendNow} disabled={sendingNow || !s?.mail?.configured}
            title="Sends exactly what the scheduler would send now (respects quiet hours)."
            className="bg-accent text-white rounded-lg px-4 py-2 text-sm font-semibold flex items-center gap-2 disabled:opacity-50">
            {sendingNow ? <Loader2 className="w-4 h-4 animate-spin" /> : <BellRing className="w-4 h-4" />} Send due reminders now
          </button>
        </div>
        {preview && (
          <div className="text-sm">
            <div className="text-xs text-muted-foreground mb-1">
              {preview.dryRun ? "Preview" : "Run"}: {preview.due} due · {preview.dryRun ? preview.items.filter((i) => i.outcome === "would send").length + " would send" : `${preview.sent} sent, ${preview.failed} failed`} · {preview.noRecipient} without a recipient{preview.deferred ? ` · ${preview.deferred} deferred` : ""}
              {preview.status !== "completed" && <span className="text-amber-700"> · {preview.status.replace("_", " ")}</span>}
            </div>
            {preview.items.length > 0 && (
              <div className="overflow-x-auto border border-border rounded-lg">
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-muted-foreground bg-secondary/50"><th className="px-3 py-1.5">Appointment</th><th className="px-3 py-1.5">Customer</th><th className="px-3 py-1.5">Rep</th><th className="px-3 py-1.5">To</th><th className="px-3 py-1.5">Outcome</th></tr></thead>
                  <tbody>
                    {preview.items.map((i) => (
                      <tr key={i.jp_appointment_id} className="border-t border-border/50">
                        <td className="px-3 py-1.5 whitespace-nowrap">{fmtWhen(i.starts_at)}</td>
                        <td className="px-3 py-1.5">{i.customer_name || "—"}</td>
                        <td className="px-3 py-1.5">{i.sales_rep}</td>
                        <td className="px-3 py-1.5">{i.to || <span className="text-amber-700">no recipient</span>}</td>
                        <td className={`px-3 py-1.5 ${i.outcome.startsWith("failed") ? "text-red-600" : i.outcome === "no recipient" ? "text-amber-700" : ""}`}>{i.outcome}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Recipients */}
      <div className="bg-white rounded-xl border border-border shadow-sm">
        <div className="p-4 pb-2">
          <h2 className="font-heading font-bold text-sm text-primary">Recipients</h2>
          <p className="text-xs text-muted-foreground">
            One row per rep, named exactly as JobProgress names them on appointments. Enter the email HR provided and keep the switch on.
            Reps with a due reminder but no email are highlighted. Login accounts are not used for this.
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-4 py-2">Rep (as in JobProgress)</th>
                <th className="px-4 py-2">Sales appts (recent)</th>
                <th className="px-4 py-2">Last seen</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Receives reminders</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-muted-foreground text-sm">No CRM rep names yet — run the JobProgress sync first.</td></tr>}
              {rows.map((r) => <RecipientRow key={r.key} row={r} onSaved={() => qc.invalidateQueries({ queryKey: ["reminder-recipients"] })} />)}
            </tbody>
          </table>
        </div>
      </div>

      {/* Log */}
      <div className="bg-white rounded-xl border border-border shadow-sm">
        <div className="flex items-center gap-2 p-4 pb-2"><History className="w-4 h-4 text-primary" /><h2 className="font-heading font-bold text-sm text-primary">Sent reminders</h2></div>
        {log.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing sent yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2">Sent</th><th className="px-4 py-2">To</th><th className="px-4 py-2">Rep</th><th className="px-4 py-2">Customer</th><th className="px-4 py-2">Appointment</th><th className="px-4 py-2">Status</th><th className="px-4 py-2">By</th>
                </tr>
              </thead>
              <tbody>
                {log.slice(0, 50).map((r) => (
                  <tr key={r.id} className="border-b border-border/50">
                    <td className="px-4 py-2 whitespace-nowrap">{fmtWhen(r.created_at)}</td>
                    <td className="px-4 py-2">{r.recipient_email}</td>
                    <td className="px-4 py-2">{r.rep_name}</td>
                    <td className="px-4 py-2">{r.customer_name}</td>
                    <td className="px-4 py-2 whitespace-nowrap">{r.starts_at ? fmtWhen(r.starts_at) : "—"}</td>
                    <td className={`px-4 py-2 font-semibold ${r.status === "sent" ? "text-green-700" : r.status === "test" ? "text-sky-700" : "text-red-600"}`} title={r.error || ""}>{r.status}{r.error ? " ⓘ" : ""}</td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">{r.sent_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function clock(h) { const hr = h % 12 === 0 ? 12 : h % 12; return `${hr} ${h >= 12 ? "PM" : "AM"}`; }

function RecipientRow({ row, onSaved }) {
  const { toast } = useToast();
  const [email, setEmail] = useState(row.recipient?.email ?? "");
  const [active, setActive] = useState(row.recipient ? row.recipient.active !== false : true);
  const [saving, setSaving] = useState(false);
  const dirty = email !== (row.recipient?.email ?? "") || active !== (row.recipient ? row.recipient.active !== false : true);
  const validEmail = email === "" || EMAIL_RE.test(email.trim());

  async function save() {
    setSaving(true);
    try {
      const payload = { rep_name: row.rep_name, email: email.trim() || null, active };
      if (row.recipient) await base44.entities.DebriefReminderRecipient.update(row.recipient.id, payload);
      else await base44.entities.DebriefReminderRecipient.create(payload);
      toast({ title: "Saved", description: `${row.rep_name}: ${email.trim() || "no email"}${active ? "" : " (off)"}` });
      onSaved();
    } catch (err) {
      toast({ title: "Not saved", description: err.message, variant: "destructive" });
    } finally { setSaving(false); }
  }

  const receiving = !!row.recipient?.email && row.recipient.active !== false;
  return (
    <tr className={`border-b border-border/50 ${row.dueUnmatched ? "bg-amber-50" : ""}`}>
      <td className="px-4 py-2 font-medium whitespace-nowrap">
        {row.rep_name}
        {row.dueUnmatched && <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-bold text-amber-800"><AlertTriangle className="w-3 h-3" /> due, no email</span>}
      </td>
      <td className="px-4 py-2">{row.appointments || "—"}</td>
      <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">{row.last_seen ? `${usDate(row.last_seen)} ${simpleTime(new Date(row.last_seen).toTimeString().slice(0, 5))}` : "—"}</td>
      <td className="px-4 py-2">
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rep@alliednj.com"
          className={`border rounded-lg px-3 py-1.5 text-sm font-medium bg-white w-64 ${validEmail ? "border-input" : "border-red-400"}`} />
      </td>
      <td className="px-4 py-2">
        <button type="button" onClick={() => setActive((v) => !v)}
          className={`px-3 py-1 rounded-full text-xs font-semibold border ${active ? "bg-green-600 text-white border-green-600" : "bg-white text-muted-foreground border-border"}`}>
          {active ? "On" : "Off"}
        </button>
      </td>
      <td className="px-4 py-2 text-right whitespace-nowrap">
        {dirty ? (
          <button onClick={save} disabled={saving || !validEmail}
            className="bg-primary text-primary-foreground rounded-lg px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} Save
          </button>
        ) : receiving ? (
          <span className="text-xs text-green-700 inline-flex items-center gap-1"><Check className="w-3 h-3" /> receiving</span>
        ) : (
          <span className="text-xs text-muted-foreground">not receiving</span>
        )}
      </td>
    </tr>
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
