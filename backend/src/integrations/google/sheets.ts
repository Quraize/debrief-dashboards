/**
 * Google Sheets, the small part of it this app needs: sign in as the service
 * account, read a tab, apply a batch of structural/value updates.
 *
 * No SDK. The Sheets v4 REST surface used here is three endpoints, and the
 * service-account handshake is a signed JWT swapped for a bearer token
 * (RFC 7523) — node:crypto does the RS256 signature. Keeping the dependency
 * out keeps the runtime image small and the failure modes readable.
 *
 * Credentials come from GOOGLE_SERVICE_ACCOUNT_JSON (the key file, folded to
 * one line) and never from anywhere else; the spreadsheet from
 * GOOGLE_SHEETS_SPREADSHEET_ID. The sheet must be shared with the service
 * account's client_email as Editor.
 */
import { createSign } from "node:crypto";

export interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }

export type CellValue = string | number | boolean | null;

const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URI = "https://oauth2.googleapis.com/token";

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/** The signed assertion Google exchanges for an access token. Exported for tests. */
export function serviceAccountAssertion(sa: ServiceAccount, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? TOKEN_URI, iat, exp: iat + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  return `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
}

/** Parses the key file from the environment; null when not configured. */
export function serviceAccountFromEnv(raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON): ServiceAccount | null {
  if (!raw || !raw.trim()) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON"); }
  const sa = parsed as Partial<ServiceAccount>;
  if (!sa.client_email || !sa.private_key) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key");
  return { client_email: sa.client_email, private_key: sa.private_key, token_uri: sa.token_uri };
}

export class GoogleSheetsError extends Error {
  constructor(message: string, readonly status: number | null, readonly endpoint: string) { super(message); this.name = "GoogleSheetsError"; }
}

export interface SheetsClientOptions {
  credentials: ServiceAccount;
  spreadsheetId: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export class GoogleSheetsClient {
  private readonly sa: ServiceAccount;
  readonly spreadsheetId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(opts: SheetsClientOptions) {
    this.sa = opts.credentials;
    this.spreadsheetId = opts.spreadsheetId;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** From the environment, or null when either setting is missing. */
  static fromEnv(fetchImpl?: typeof fetch): GoogleSheetsClient | null {
    const credentials = serviceAccountFromEnv();
    const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID?.trim();
    if (!credentials || !spreadsheetId) return null;
    return new GoogleSheetsClient({ credentials, spreadsheetId, fetchImpl });
  }

  private async accessToken(): Promise<string> {
    const nowMs = this.now().getTime();
    if (this.token && this.token.expiresAt - 60_000 > nowMs) return this.token.value;
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: serviceAccountAssertion(this.sa, this.now()),
    });
    const res = await this.fetchImpl(this.sa.token_uri ?? TOKEN_URI, {
      method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    if (!res.ok) throw new GoogleSheetsError(`Google sign-in failed: HTTP ${res.status} ${(await safeText(res)).slice(0, 200)}`, res.status, "token");
    const json = await res.json() as { access_token: string; expires_in: number };
    this.token = { value: json.access_token, expiresAt: nowMs + (json.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  private async request<T>(url: string, endpoint: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(url, {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (!res.ok) {
      const hint = res.status === 403 ? " (is the sheet shared with the service account as Editor?)"
        : res.status === 404 ? " (spreadsheet id wrong, or not shared)" : "";
      throw new GoogleSheetsError(`Google Sheets ${endpoint}: HTTP ${res.status}${hint} ${(await safeText(res)).slice(0, 300)}`, res.status, endpoint);
    }
    return await res.json() as T;
  }

  /** A tab by its title: its numeric id (the `gid`) and grid size; null when there is no such tab. */
  async sheetByTitle(title: string): Promise<{ sheetId: number; rowCount: number; columnCount: number } | null> {
    const body = await this.request<{ sheets?: { properties?: { sheetId?: number; title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[] }>(
      `${SHEETS}/${this.spreadsheetId}?fields=sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))`, "spreadsheet");
    const hit = (body.sheets ?? []).find((s) => s.properties?.title === title)?.properties;
    if (!hit || hit.sheetId === undefined) return null;
    return { sheetId: hit.sheetId, rowCount: hit.gridProperties?.rowCount ?? 1000, columnCount: hit.gridProperties?.columnCount ?? 26 };
  }

  /** The numeric sheet id (the `gid`) of a tab, by its title; null when there is no such tab. */
  async sheetIdByTitle(title: string): Promise<number | null> {
    return (await this.sheetByTitle(title))?.sheetId ?? null;
  }

  /** Every non-empty row of a tab as raw values (dates as serial numbers, checkboxes as booleans). */
  async getValues(range: string): Promise<CellValue[][]> {
    const url = `${SHEETS}/${this.spreadsheetId}/values/${encodeURIComponent(range)}`
      + `?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`;
    const body = await this.request<{ values?: CellValue[][] }>(url, "values.get");
    return body.values ?? [];
  }

  /** Applies structural and value changes in order, in one round trip per chunk. */
  async batchUpdate(requests: unknown[]): Promise<void> {
    for (let i = 0; i < requests.length; i += 500) {
      await this.request(`${SHEETS}/${this.spreadsheetId}:batchUpdate`, "batchUpdate", {
        method: "POST", body: { requests: requests.slice(i, i + 500), includeSpreadsheetInResponse: false },
      });
    }
  }
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).replace(/\s+/g, " "); } catch { return ""; }
}

/** `'[AUTOMATION]WEEKLY JOB SHEET'!A1:HZ` — a tab title quoted for the A1 grammar. */
export function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}
