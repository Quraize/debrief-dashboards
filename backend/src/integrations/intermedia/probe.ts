/**
 * The Unite connection test: does each API answer, and what is on the other
 * side. Run from the admin page before anything is built on top of it.
 *
 * Stores nothing. Reports per API: token obtained or the identity server's
 * reason; then how many users have an extension, how many calls the account
 * made yesterday, and whether one user's recordings can be listed. Phone
 * numbers in the sample are masked — this is a health check, not a call log.
 */
import { UniteClient, uniteConfig, SCOPES, type UniteCallDetail, type UniteContact } from "./client.js";
import { phoneKey } from "@allied/shared/phone";

export interface ProbeStep { name: string; ok: boolean; detail: string }
export interface ProbeResult {
  configured: boolean; reason: string; apiBase: string;
  steps: ProbeStep[];
  users: { total: number; withExtension: number; sample: { name: string; extension: string | null }[] };
  calls: { window: string; total: number; inbound: number; outbound: number; internal: number; matchableNumbers: number; sample: { start: string; direction: string; from: string; to: string; seconds: number }[] };
  recordings: { user: string | null; listed: number | null; newest: string | null };
  /** Can the audio actually be downloaded? Decides whether transcription is possible without Contact Center. */
  audio: { tried: boolean; ok: boolean; status: number | null; contentType: string | null; bytes: number | null; detail: string };
  /** Recordings listed for an auto attendant, if one is on the account. */
  autoAttendant: { user: string | null; listed: number | null; detail: string };
}

const mask = (n: string | null | undefined): string => {
  const k = phoneKey(n ?? "");
  if (k) return `(${k.slice(0, 3)}) •••-${k.slice(6)}`;
  return n ? `${String(n).slice(0, 3)}…` : "—";
};

export async function probeUnite(options: { env?: NodeJS.ProcessEnv; client?: UniteClient; now?: Date } = {}): Promise<ProbeResult> {
  const env = options.env ?? process.env;
  const c = uniteConfig(env);
  const now = options.now ?? new Date();
  const result: ProbeResult = {
    configured: c.configured, reason: c.reason, apiBase: c.config.apiBase, steps: [],
    users: { total: 0, withExtension: 0, sample: [] },
    calls: { window: "", total: 0, inbound: 0, outbound: 0, internal: 0, matchableNumbers: 0, sample: [] },
    recordings: { user: null, listed: null, newest: null },
    audio: { tried: false, ok: false, status: null, contentType: null, bytes: null, detail: "not tried" },
    autoAttendant: { user: null, listed: null, detail: "no auto attendant found" },
  };
  if (!c.configured) return result;
  const client = options.client ?? new UniteClient(c.config);
  const step = (name: string, ok: boolean, detail: string) => result.steps.push({ name, ok, detail });

  // 1. Users — also the source of the unified user ids the recordings API needs.
  let users: UniteContact[] = [];
  let signedIn = false;
  try {
    await client.token(SCOPES.addressBook);
    signedIn = true;
    step("Sign in — Address Book", true, `scope ${SCOPES.addressBook}`);
    const all = await client.listAccountContacts();
    users = all.filter((u) => u.pbx?.extension);
    result.users = {
      total: all.length, withExtension: users.length,
      sample: users.slice(0, 8).map((u) => ({ name: u.displayName ?? "—", extension: u.pbx?.extension ?? null })),
    };
    step("List account users", true, `${all.length} contact(s), ${users.length} with an extension`);
  } catch (err) {
    step(signedIn ? "List account users" : "Sign in — Address Book", false, (err as Error).message);
  }

  // 2. Yesterday's calls, one record per call.
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(to.getTime() - 86_400_000);
  result.calls.window = `${from.toISOString().slice(0, 10)} (UTC day)`;
  try {
    await client.token(SCOPES.analytics);
    step("Sign in — Analytics", true, `scope ${SCOPES.analytics}`);
    const { calls, totalCalls } = await client.listCallDetails(from, to, { size: 500, maxPages: 4 });
    const dir = (d: string) => calls.filter((x) => x.direction === d).length;
    const external = (x: UniteCallDetail) => x.direction === "inbound" ? x.from.number : x.to.number;
    result.calls = {
      ...result.calls, total: totalCalls, inbound: dir("inbound"), outbound: dir("outbound"), internal: dir("internal"),
      matchableNumbers: calls.filter((x) => x.direction !== "internal" && phoneKey(external(x) ?? "")).length,
      sample: calls.slice(0, 5).map((x) => ({ start: x.start, direction: x.direction, from: mask(x.from.number), to: mask(x.to.number), seconds: x.duration })),
    };
    step("List yesterday's calls", true, `${totalCalls} call(s): ${result.calls.inbound} in, ${result.calls.outbound} out, ${result.calls.internal} internal; ${result.calls.matchableNumbers} with a matchable outside number`);
  } catch (err) {
    step(result.steps.some((s) => s.name === "Sign in — Analytics") ? "List yesterday's calls" : "Sign in — Analytics", false, (err as Error).message);
  }

  // 3. Recordings for one user (the API is per user), then the download itself.
  // Prefer a person over an auto attendant so the audio test is a real call.
  const isAA = (u: UniteContact) => /\bAA\b|auto.?attendant/i.test(u.displayName ?? "");
  const first = users.find((u) => !isAA(u)) ?? users[0];
  let signedInRec = false;
  try {
    await client.token(SCOPES.recordings);
    signedInRec = true;
    step("Sign in — Call Recordings", true, `scope ${SCOPES.recordings}`);
    if (first) {
      const recs = await client.listCallRecordings(first.id, { count: 20 });
      result.recordings = { user: first.displayName ?? first.id, listed: recs.length, newest: recs[0]?.whenCreated ?? null };
      step(`List recordings — ${first.displayName ?? first.id}`, true, `${recs.length} listed${recs[0]?.whenCreated ? `, newest ${recs[0].whenCreated}` : ""}`);
      const newest = recs[0];
      if (newest) {
        result.audio.tried = true;
        try {
          const res = await client.recordingContent(first.id, newest.id, { rangeBytes: 65_536 });
          const buf = new Uint8Array(await res.arrayBuffer());
          result.audio = { tried: true, ok: buf.length > 0, status: res.status, contentType: res.headers.get("content-type"), bytes: buf.length,
            detail: buf.length > 0 ? `HTTP ${res.status}, ${res.headers.get("content-type") ?? "unknown type"}, ${buf.length} bytes received` : `HTTP ${res.status} but an empty body` };
          step("Download recording audio", result.audio.ok, result.audio.detail);
        } catch (err) {
          result.audio = { tried: true, ok: false, status: (err as { status?: number }).status ?? null, contentType: null, bytes: null, detail: (err as Error).message };
          step("Download recording audio", false, (err as Error).message);
        }
      }
    } else {
      step("List recordings", false, "no user with an extension to test against");
    }
    // 4. An auto attendant, if the account has one: the spec says none; the account may say otherwise.
    const aa = users.find(isAA);
    if (aa) {
      try {
        const recs = await client.listCallRecordings(aa.id, { count: 20 });
        result.autoAttendant = { user: aa.displayName ?? aa.id, listed: recs.length, detail: `${recs.length} listed` };
        step(`List recordings — ${aa.displayName ?? aa.id} (auto attendant)`, true, `${recs.length} listed`);
      } catch (err) {
        result.autoAttendant = { user: aa.displayName ?? aa.id, listed: null, detail: (err as Error).message };
        step(`List recordings — ${aa.displayName ?? aa.id} (auto attendant)`, false, (err as Error).message);
      }
    }
  } catch (err) {
    step(signedInRec ? "List recordings" : "Sign in — Call Recordings", false, (err as Error).message);
  }
  return result;
}
