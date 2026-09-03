/**
 * Users (admin) — account administration without touching the server:
 * create accounts, change roles, disable/enable, unlock, reset passwords,
 * sign someone out everywhere. Every action is enforced server-side and
 * written to the auth audit trail.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useAuth } from "@/lib/AuthContext";
import { useToast } from "@/components/ui/use-toast";
import { ROLE_LABELS, ROLES } from "@allied/shared/constants";
import { Loader2, UserPlus, Lock, RefreshCw, Copy } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : "—");

/** 16 characters from an unambiguous alphabet — comfortably past the 12 minimum. */
function generatePassword() {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export default function Users() {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const isAdmin = !!me && me.role === "admin";

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["admin-users"], queryFn: api.admin.users.list, enabled: isAdmin,
  });

  const [form, setForm] = useState({ email: "", full_name: "", role: "outside_sales_rep", password: "" });
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState(null); // { email, password } shown once
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState("");

  if (me && !isAdmin) return <div className="py-20 text-center text-muted-foreground">Admin access required.</div>;
  if (!me) return <div className="flex justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;

  const refresh = () => qc.invalidateQueries({ queryKey: ["admin-users"] });
  const fail = (title) => (err) => toast({ title, description: err.message, variant: "destructive" });

  async function createUser(e) {
    e.preventDefault();
    setCreating(true);
    try {
      await api.admin.users.create(form);
      setRevealed({ email: form.email.trim().toLowerCase(), password: form.password });
      toast({ title: "Account created", description: `${form.email} can sign in now.` });
      setForm({ email: "", full_name: "", role: "outside_sales_rep", password: "" });
      refresh();
    } catch (err) {
      fail("Could not create account")(err);
    } finally {
      setCreating(false);
    }
  }

  async function setRole(u, role) {
    try {
      await api.admin.users.update(u.id, { role });
      toast({ title: "Role updated", description: `${u.email} is now ${ROLE_LABELS[role] ?? role}.` });
      refresh();
    } catch (err) { fail("Could not change role")(err); }
  }

  async function setActive(u, active) {
    try {
      const res = await api.admin.users.update(u.id, { active });
      toast({
        title: active ? "Account enabled" : "Account disabled",
        description: active ? `${u.email} can sign in again.` : `${u.email} signed out of ${res.sessionsRevoked} session(s).`,
      });
      refresh();
    } catch (err) { fail(active ? "Could not enable" : "Could not disable")(err); }
  }

  async function unlock(u) {
    try {
      await api.admin.users.unlock(u.id);
      toast({ title: "Account unlocked", description: `${u.email} can try signing in again.` });
      refresh();
    } catch (err) { fail("Could not unlock")(err); }
  }

  async function doReset() {
    try {
      const res = await api.admin.users.resetPassword(resetTarget.id, resetPassword);
      setRevealed({ email: resetTarget.email, password: resetPassword });
      toast({ title: "Password reset", description: `${res.sessionsRevoked} session(s) signed out.` });
      setResetTarget(null);
      setResetPassword("");
      refresh();
    } catch (err) { fail("Could not reset password")(err); }
  }

  async function revokeSessions(u) {
    try {
      const res = await api.admin.users.revokeSessions(u.id);
      toast({ title: "Signed out everywhere", description: `${u.email}: ${res.revoked} session(s) ended.` });
      refresh();
    } catch (err) { fail("Could not sign out sessions")(err); }
  }

  const input = "border border-input rounded-lg px-3 py-2 text-sm bg-white";

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-heading font-bold text-primary">Users</h1>
        <p className="text-sm text-muted-foreground">Accounts, roles and access. Every action here is recorded in the security audit log.</p>
      </div>

      {revealed && (
        <div className="bg-amber-50 border border-amber-300 rounded-xl p-4 text-sm space-y-1">
          <div className="font-semibold text-amber-900">Temporary password for {revealed.email} — shown once</div>
          <div className="flex items-center gap-2">
            <code className="bg-white border border-amber-200 rounded px-2 py-1 font-mono">{revealed.password}</code>
            <button onClick={() => navigator.clipboard?.writeText(revealed.password)} className="text-amber-900 flex items-center gap-1 text-xs font-semibold">
              <Copy className="w-3.5 h-3.5" /> Copy
            </button>
            <button onClick={() => setRevealed(null)} className="ml-auto text-xs text-amber-900 underline">Dismiss</button>
          </div>
          <p className="text-xs text-amber-800">Share it in person or via a password manager — never by chat or email. Ask them to change it from My Account.</p>
        </div>
      )}

      {/* Create */}
      <form onSubmit={createUser} className="bg-white rounded-xl border border-border p-4 shadow-sm space-y-3">
        <div className="flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-primary" />
          <h2 className="font-heading font-bold text-sm text-primary">Create Account</h2>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input type="email" required placeholder="email@alliednj.com" value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })} className={input} />
          <input placeholder="Full name" value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })} className={input} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} className={input}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
          </select>
          <div className="flex gap-2">
            <input required minLength={12} placeholder="Temporary password (12+)" value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })} className={`${input} flex-1 font-mono`} />
            <button type="button" onClick={() => setForm({ ...form, password: generatePassword() })}
              className="border border-border rounded-lg px-3 text-xs font-semibold" title="Generate a strong password">
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
        <button type="submit" disabled={creating}
          className="bg-primary text-primary-foreground rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50">
          {creating ? "Creating…" : "Create account"}
        </button>
      </form>

      {/* List */}
      <div className="bg-white rounded-xl border border-border shadow-sm overflow-x-auto">
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground border-b border-border">
                <th className="px-4 py-2">User</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">2FA</th>
                <th className="px-4 py-2">Sessions</th>
                <th className="px-4 py-2">Last sign-in</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.email === me.email;
                return (
                  <tr key={u.id} className="border-b border-border/50 align-top">
                    <td className="px-4 py-2">
                      <div className="font-semibold">{u.fullName || u.email}{self && <span className="ml-2 text-[10px] font-bold uppercase bg-sky-100 text-sky-700 px-2 py-0.5 rounded-full">You</span>}</div>
                      <div className="text-xs text-muted-foreground">{u.email}</div>
                    </td>
                    <td className="px-4 py-2">
                      <select value={u.role} disabled={self} onChange={(e) => setRole(u, e.target.value)}
                        className="border border-input rounded-lg px-2 py-1 text-xs bg-white disabled:opacity-60">
                        {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r] ?? r}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      {!u.active ? <span className="text-red-600 font-semibold">Disabled</span>
                        : u.lockedUntil ? <span className="text-amber-700 font-semibold flex items-center gap-1"><Lock className="w-3 h-3" /> Locked</span>
                        : <span className="text-green-700 font-semibold">Active</span>}
                    </td>
                    <td className="px-4 py-2">{u.totpEnrolled ? <span className="text-green-700">On</span> : <span className="text-muted-foreground">Off</span>}</td>
                    <td className="px-4 py-2">{u.activeSessions}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-xs text-muted-foreground">{fmt(u.lastLoginAt)}</td>
                    <td className="px-4 py-2">
                      <div className="flex flex-wrap gap-2 text-xs font-semibold">
                        {u.lockedUntil && <button onClick={() => unlock(u)} className="text-amber-700">Unlock</button>}
                        <button onClick={() => { setResetTarget(u); setResetPassword(generatePassword()); }} className="text-primary">Reset password</button>
                        {u.activeSessions > 0 && <button onClick={() => revokeSessions(u)} className="text-primary">Sign out all</button>}
                        {!self && (u.active
                          ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild><button className="text-red-700">Disable</button></AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Disable {u.email}?</AlertDialogTitle>
                                  <AlertDialogDescription>They are signed out immediately and cannot sign in until re-enabled. Nothing is deleted.</AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                                  <AlertDialogAction onClick={() => setActive(u, false)}>Disable</AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          )
                          : <button onClick={() => setActive(u, true)} className="text-green-700">Enable</button>)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Reset password dialog */}
      <AlertDialog open={!!resetTarget} onOpenChange={(o) => { if (!o) setResetTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset password for {resetTarget?.email}</AlertDialogTitle>
            <AlertDialogDescription>
              Sets this temporary password and signs them out of every device. You'll see it once after confirming.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex gap-2">
            <input value={resetPassword} minLength={12} onChange={(e) => setResetPassword(e.target.value)}
              className={`${input} flex-1 font-mono`} />
            <button type="button" onClick={() => setResetPassword(generatePassword())}
              className="border border-border rounded-lg px-3 text-xs font-semibold"><RefreshCw className="w-4 h-4" /></button>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doReset} disabled={resetPassword.length < 12}>Reset password</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
