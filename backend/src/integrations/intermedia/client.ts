/**
 * Intermedia Unite (Extend API), the small part of it this app needs.
 *
 * Read from the vendor's OpenAPI specs and guides on 2026-09-18
 * (developer.intermedia.com/api/spec/{calling,analytics,address_book}):
 *
 *   Token   POST https://login.intermedia.net/user/connect/token
 *           grant_type=client_credentials, client_id, client_secret, scope —
 *           one token PER SCOPE; a service account is the only client type
 *           that can use this flow. Tokens last an hour (expires_in).
 *   Users   GET  /address-book/v3/accounts/_me/contacts        scope api.service.address-book
 *           every person on the account with their extension and numbers;
 *           `id` is the unified user id the Voice API wants.
 *   Calls   POST /analytics/calls/call/detail?dateFrom&dateTo&offset&size
 *                                                              scope api.service.analytics.main
 *           one record per call (legs merged): direction, duration, start,
 *           from/to with number, name and userUniqueId, globalCallId.
 *   Audio   GET  /voice/v2/accounts/_me/users/{uuid}/call-recordings?offset&count
 *           GET  …/call-recordings/{id}/_content             scope api.service.voice.call-recordings
 *           per USER only — the spec says auto attendants and hunt groups
 *           have no recordings through this API.
 *
 * Nothing here is a transcript: the Voice API transcribes voicemails, not
 * call recordings. AI Call Recap output has no endpoint in these specs.
 *
 * Credentials come from INTERMEDIA_CLIENT_ID / INTERMEDIA_CLIENT_SECRET and
 * never from anywhere else. The secret is never logged, never returned.
 * Rate limit per the vendor: 250 requests/minute per client.
 */

export const SCOPES = {
  addressBook: "api.service.address-book",
  analytics: "api.service.analytics.main",
  recordings: "api.service.voice.call-recordings",
  notifications: "api.service.notifications",
} as const;
export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

const DEFAULT_TOKEN_URL = "https://login.intermedia.net/user/connect/token";
const DEFAULT_API_BASE = "https://api.intermedia.net";

export interface UniteConfig { clientId: string; clientSecret: string; tokenUrl: string; apiBase: string }

/** What the environment says; `configured` false with a reason when a piece is missing. */
export function uniteConfig(env: NodeJS.ProcessEnv = process.env): { configured: boolean; reason: string; config: UniteConfig } {
  const config: UniteConfig = {
    clientId: (env.INTERMEDIA_CLIENT_ID ?? "").trim(),
    clientSecret: (env.INTERMEDIA_CLIENT_SECRET ?? "").trim(),
    // `||`, not `??`: docker compose passes an unset variable as "" and an
    // empty address must mean "the vendor's default", not "sign in at ''".
    tokenUrl: ((env.INTERMEDIA_TOKEN_URL ?? "").trim() || DEFAULT_TOKEN_URL),
    apiBase: ((env.INTERMEDIA_API_BASE ?? "").trim() || DEFAULT_API_BASE).replace(/\/+$/, ""),
  };
  if (!config.clientId) return { configured: false, reason: "INTERMEDIA_CLIENT_ID not set", config };
  if (!config.clientSecret) return { configured: false, reason: "INTERMEDIA_CLIENT_SECRET not set", config };
  return { configured: true, reason: "", config };
}

export class UniteError extends Error {
  constructor(message: string, readonly status: number | null, readonly endpoint: string) { super(message); this.name = "UniteError"; }
}

export interface UniteContact {
  id: string; type: string | null; displayName: string | null; email: string | null;
  phoneNumbers: { type: string | null; number: string | null; internationalFormatNumber: string | null }[];
  pbx: { enabled?: boolean; extension?: string | null } | null;
}

export interface UniteParticipant {
  number: string | null; name: string | null; userUniqueId: string | null;
  device: { deviceType?: string | null } | null;
}

export interface UniteCallDetail {
  id: string; globalCallId: string | null; start: string; duration: number;
  direction: "inbound" | "outbound" | "internal" | string;
  from: UniteParticipant; to: UniteParticipant; group: string | null;
}

export interface UniteRecording {
  id: number; fileName: string | null; duration: number | null; callId: string | null;
  whenCreated: string | null; direction: string | null; wasPaused: boolean | null; status: string | null;
  caller: { phoneNumber?: string | null; displayName?: string | null } | null;
}

export class UniteClient {
  private readonly cfg: UniteConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private tokens = new Map<string, { value: string; expiresAt: number }>();

  constructor(cfg: UniteConfig, opts: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
    this.cfg = cfg;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env, opts: { fetchImpl?: typeof fetch } = {}): UniteClient | null {
    const c = uniteConfig(env);
    return c.configured ? new UniteClient(c.config, opts) : null;
  }

  /** A bearer token for one scope, cached until a minute before it expires. */
  async token(scope: Scope): Promise<string> {
    const nowMs = this.now().getTime();
    const have = this.tokens.get(scope);
    if (have && have.expiresAt - 60_000 > nowMs) return have.value;
    const body = new URLSearchParams({
      grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope,
    });
    const res = await this.fetchImpl(this.cfg.tokenUrl, {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body,
    });
    if (!res.ok) {
      // The identity server's error body names the problem (invalid_client,
      // invalid_scope) without echoing the secret; keep it short.
      throw new UniteError(`Unite sign-in failed for scope ${scope}: HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`, res.status, "token");
    }
    const json = await res.json() as { access_token: string; expires_in?: number };
    const value = json.access_token;
    this.tokens.set(scope, { value, expiresAt: nowMs + (json.expires_in ?? 3600) * 1000 });
    return value;
  }

  private async request<T>(scope: Scope, path: string, endpoint: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}): Promise<T> {
    const token = await this.token(scope);
    const url = new URL(`${this.cfg.apiBase}${path}`);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url.toString(), {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      const hint = res.status === 401 ? " (token rejected — is the scope enabled for this service account?)"
        : res.status === 403 ? " (forbidden — the account may not have this API enabled)"
        : res.status === 404 ? " (not found — wrong API base, or this object does not exist)" : "";
      throw new UniteError(`Unite ${endpoint}: HTTP ${res.status}${hint} ${(await safeText(res)).slice(0, 300)}`, res.status, endpoint);
    }
    return await res.json() as T;
  }

  /** Everyone on the account, paged. A user has `pbx.extension`; contacts and rooms do not. */
  async listAccountContacts(): Promise<UniteContact[]> {
    const out: UniteContact[] = [];
    let offsetToken: string | undefined;
    for (let page = 0; page < 50; page++) {
      const body = await this.request<{ results?: UniteContact[]; nextPageOffsetToken?: string }>(
        SCOPES.addressBook, "/address-book/v3/accounts/_me/contacts", "address-book:contacts",
        // No `fields` filter: the live API rejected a name from the spec's own
        // list ("The given value is not supported"), and the full contact is small.
        { query: { count: 1000, offsetToken } });
      out.push(...(body.results ?? []));
      offsetToken = body.nextPageOffsetToken || undefined;
      if (!offsetToken) break;
    }
    return out;
  }

  /**
   * Calls that STARTED in [from, to), one record per call. `size` per page;
   * the vendor caps page size, so this pages until `totalCalls` is reached.
   */
  async listCallDetails(from: Date, to: Date, opts: { size?: number; maxPages?: number } = {}): Promise<{ calls: UniteCallDetail[]; totalCalls: number }> {
    const size = opts.size ?? 500;
    const calls: UniteCallDetail[] = [];
    let total = 0;
    for (let page = 0; page < (opts.maxPages ?? 200); page++) {
      const body = await this.request<{ calls?: UniteCallDetail[]; totalCalls?: number }>(
        SCOPES.analytics, "/analytics/calls/call/detail", "analytics:call-detail",
        { method: "POST", body: {}, query: { dateFrom: iso(from), dateTo: iso(to), offset: page * size, size, sortColumn: "start", descending: "false" } });
      const got = body.calls ?? [];
      calls.push(...got);
      total = body.totalCalls ?? calls.length;
      if (got.length === 0 || calls.length >= total) break;
    }
    return { calls, totalCalls: total };
  }

  /** One user's recordings, newest first as the vendor returns them. */
  async listCallRecordings(unifiedUserId: string, opts: { offset?: number; count?: number } = {}): Promise<UniteRecording[]> {
    const body = await this.request<{ records?: UniteRecording[] }>(
      SCOPES.recordings, `/voice/v2/accounts/_me/users/${encodeURIComponent(unifiedUserId)}/call-recordings`, "voice:call-recordings",
      { query: { offset: opts.offset ?? 0, count: opts.count ?? 100 } });
    return body.records ?? [];
  }

  /** The audio itself, as the vendor streams it (mp3 in the documented example). */
  async recordingContent(unifiedUserId: string, recordingId: number | string): Promise<Response> {
    const token = await this.token(SCOPES.recordings);
    const res = await this.fetchImpl(
      `${this.cfg.apiBase}/voice/v2/accounts/_me/users/${encodeURIComponent(unifiedUserId)}/call-recordings/${encodeURIComponent(String(recordingId))}/_content`,
      { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new UniteError(`Unite voice:recording-content: HTTP ${res.status}`, res.status, "voice:recording-content");
    return res;
  }
}

/** yyyy-MM-dd'T'HH:mm:ss.SSSZ — the Analytics API's date format, UTC. */
export const iso = (d: Date): string => d.toISOString();

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).replace(/\s+/g, " "); } catch { return ""; }
}
