/**
 * My Account — self-service security for the signed-in user: change password,
 * enroll a second factor, see and revoke active sessions, sign out everywhere
 * else. Everything here works against the existing server-side session model.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useToast } from "@/components/ui/use-toast";
import { Loader2, KeyRound, ShieldCheck, MonitorSmartphone, LogOut } from "lucide-react";

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/** "Chrome on Windows"-style summary; the raw string is available on hover. */
function describeAgent(ua) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export default function Account() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: account, isLoading } = useQuery({ queryKey: ["account"], queryFn: api.auth.account });
  const { data: sessions = [] } = useQuery({ queryKey: ["sessions"], queryFn: api.auth.sessions.list });

  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwBusy, setPwBusy] = useState(false);
  const [enroll, setEnroll] = useState(null); // { secret, qrDataUri }
  const [code, setCode] = useState("");
  const [busyId, setBusyId] = useState(null);

  async function changePassword(e) {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    setPwBusy(true);
    try {
      const res = await api.auth.changePassword(pw.current, pw.next);
      toast({
        title: "Password changed",
        description: res.otherSessionsRevoked > 0
          ? `${res.otherSessionsRevoked} other session(s) were signed out.`
          : "You stay signed in here.",
      });
      setPw({ current: "", next: "", confirm: "" });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["account"] });
    } catch (err) {
      toast({ title: "Could not change password", description: err.message, variant: "destructive" });
    } finally {
      setPwBusy(false);
    }
  }

  async function beginEnroll() {
    try {
      setEnroll(await api.auth.totp.begin());
    } catch (err) {
      toast({ title: "Could not start enrollment", description: err.message, variant: "destructive" });
    }
  }

  async function confirmEnroll(e) {
    e.preventDefault();
    try {
      const res = await api.auth.totp.confirm(enroll.secret, code.trim());
      toast({
        title: "Two-factor authentication enabled",
        description: res.otherSessionsRevoked > 0 ? `${res.otherSessionsRevoked} other session(s) were signed out.` : undefined,
      });
      setEnroll(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["account"] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toast({ title: "Code not accepted", description: err.message, variant: "destructive" });
    }
  }

  async function revoke(id) {
    setBusyId(id);
    try {
      await api.auth.sessions.revoke(id);
      toast({ title: "Session signed out" });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toast({ title: "Could not revoke session", description: err.message, variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  }

  async function revokeOthers() {
    try {
      const res = await api.auth.sessions.revokeOthers();
      toast({ title: "Signed out everywhere else", description: `${res.revoked} session(s) ended.` });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    } catch (err) {
      toast({ title: "Could not sign out other sessions", description: err.message, variant: "destructive" });
    }
  }

  if (isLoading || !account) {
    return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  const input = "border border-input rounded-lg px-3 py-2 text-sm bg-white w-full";

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">My Account</h1>
        <p className="text-sm text-muted-foreground">
          {account.email} · <span className="capitalize">{account.role.replace(/_/g, " ")}</span>
          {account.lastLoginAt && <> · last sign-in {fmt(account.lastLoginAt)}</>}
        </p>
      </div>

      {/* Password */}
      <form onSubmit={changePassword} className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-primary" />
          <h2 className="font-heading font-bold text-sm text-primary">Change Password</h2>
          <span className="text-xs text-muted-foreground ml-auto">last changed {fmt(account.passwordChangedAt)}</span>
        </div>
        <div className="grid sm:grid-cols-3 gap-3">
          <input type="password" autoComplete="current-password" placeholder="Current password" required
            value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className={input} />
          <input type="password" autoComplete="new-password" placeholder="New password (12+ characters)" required minLength={12}
            value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className={input} />
          <input type="password" autoComplete="new-password" placeholder="Confirm new password" required
            value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} className={input} />
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" disabled={pwBusy}
            className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
            {pwBusy ? "Changing…" : "Change password"}
          </button>
          <span className="text-xs text-muted-foreground">Changing it signs out all your other devices. This one stays signed in.</span>
        </div>
      </form>

      {/* Two-factor */}
      <div className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className={`w-4 h-4 ${account.totpEnrolled ? "text-green-700" : "text-amber-600"}`} />
          <h2 className="font-heading font-bold text-sm text-primary">Two-Factor Authentication</h2>
          <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ml-auto ${account.totpEnrolled ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
            {account.totpEnrolled ? "Enabled" : "Not enabled"}
          </span>
        </div>
        {account.totpEnrolled ? (
          <p className="text-sm text-muted-foreground">
            Sign-in requires a code from your authenticator app. To move it to a new phone, enroll again below — the new device replaces the old one.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Strongly recommended: a code from your phone is required at sign-in, so a leaked password alone is not enough.
          </p>
        )}
        {!enroll ? (
          <button onClick={beginEnroll} className="bg-white border border-border rounded-lg px-4 py-2 text-sm font-semibold">
            {account.totpEnrolled ? "Re-enroll a new device" : "Enable two-factor"}
          </button>
        ) : (
          <form onSubmit={confirmEnroll} className="grid sm:grid-cols-[auto,1fr] gap-4 items-start">
            <img src={enroll.qrDataUri} alt="Authenticator QR code" className="w-40 h-40 border border-border rounded-lg" />
            <div className="space-y-2 text-sm">
              <p>Scan with Google Authenticator, Authy, 1Password, or any TOTP app, then enter the 6-digit code it shows.</p>
              <p className="text-xs text-muted-foreground break-all">Can't scan? Enter this key manually: <code>{enroll.secret}</code></p>
              <div className="flex gap-2">
                <input inputMode="numeric" pattern="[0-9]{6,8}" placeholder="123456" required value={code}
                  onChange={(e) => setCode(e.target.value)} className={`${input} max-w-[10rem] font-mono tracking-widest`} />
                <button type="submit" className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold">Confirm</button>
                <button type="button" onClick={() => { setEnroll(null); setCode(""); }} className="text-sm text-muted-foreground px-2">Cancel</button>
              </div>
              <p className="text-xs text-muted-foreground">Nothing is enabled until a code is confirmed.</p>
            </div>
          </form>
        )}
      </div>

      {/* Sessions */}
      <div className="bg-white rounded-xl border border-border shadow-sm">
        <div className="flex items-center gap-2 p-4 pb-2">
          <MonitorSmartphone className="w-4 h-4 text-primary" />
          <h2 className="font-heading font-bold text-sm text-primary">Active Sessions ({sessions.length})</h2>
          {sessions.length > 1 && (
            <button onClick={revokeOthers}
              className="ml-auto text-sm font-semibold text-red-700 flex items-center gap-1">
              <LogOut className="w-4 h-4" /> Sign out everywhere else
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-4 py-2">Device</th>
                <th className="px-4 py-2">IP</th>
                <th className="px-4 py-2">Signed in</th>
                <th className="px-4 py-2">Last active</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-b border-border/50">
                  <td className="px-4 py-2" title={s.userAgent || ""}>
                    {describeAgent(s.userAgent)}
                    {s.current && <span className="ml-2 text-[10px] font-bold uppercase bg-green-100 text-green-700 px-2 py-0.5 rounded-full">This device</span>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{s.ip || "—"}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(s.createdAt)}</td>
                  <td className="px-4 py-2 whitespace-nowrap">{fmt(s.lastSeenAt)}</td>
                  <td className="px-4 py-2 text-right">
                    {!s.current && (
                      <button onClick={() => revoke(s.id)} disabled={busyId === s.id}
                        className="text-sm font-semibold text-red-700 disabled:opacity-50">Sign out</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground p-4 pt-2">
          Sessions end after 12 hours without activity, and always after 7 days. Signing one out takes effect immediately.
        </p>
      </div>
    </div>
  );
}
