/** The Google Sheets connector: service-account handshake and the three calls. */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { GoogleSheetsClient, serviceAccountAssertion, serviceAccountFromEnv, a1 } from "../src/integrations/google/sheets.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const SA = {
  client_email: "debrief-platform@example.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
  token_uri: "https://oauth2.example/token",
};

describe("service account assertion", () => {
  it("is a signed RS256 JWT for the Sheets scope", () => {
    const jwt = serviceAccountAssertion(SA, new Date("2026-09-10T14:00:00Z"));
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h!, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(c!, "base64url").toString());
    expect(claims).toMatchObject({ iss: SA.client_email, aud: SA.token_uri, scope: "https://www.googleapis.com/auth/spreadsheets" });
    expect(claims.exp - claims.iat).toBe(3600);
    const v = createVerify("RSA-SHA256"); v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s!, "base64url"))).toBe(true);
  });
  it("reads the key from the environment and rejects a broken one", () => {
    expect(serviceAccountFromEnv("")).toBeNull();
    expect(serviceAccountFromEnv(undefined)).toBeNull();
    expect(() => serviceAccountFromEnv("{not json")).toThrow(/valid JSON/);
    expect(() => serviceAccountFromEnv('{"client_email":"x"}')).toThrow(/private_key/);
    expect(serviceAccountFromEnv(JSON.stringify(SA))?.client_email).toBe(SA.client_email);
  });
  it("quotes tab names for A1 ranges", () => {
    expect(a1("[AUTOMATION]WEEKLY JOB SHEET", "A1:HZ")).toBe("'[AUTOMATION]WEEKLY JOB SHEET'!A1:HZ");
    expect(a1("Bob's", "A1")).toBe("'Bob''s'!A1");
  });
});

describe("client", () => {
  function stub() {
    const calls: { url: string; method: string; body?: unknown; auth?: string }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method: init?.method ?? "GET", body: init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers["Authorization"] });
      const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) }) as unknown as Response;
      if (u.endsWith("/token")) return json({ access_token: "tok-1", expires_in: 3600 });
      if (u.includes("fields=sheets.properties")) return json({ sheets: [{ properties: { sheetId: 1204945400, title: "[AUTOMATION]WEEKLY JOB SHEET" } }, { properties: { sheetId: 1, title: "WEEKLY JOB SHEET" } }] });
      if (u.includes("/values/")) return json({ values: [["Town/Address/Customer", "PIF"], ["9/7/2026-9/13/2026"]] });
      if (u.endsWith(":batchUpdate")) return json({ replies: [] });
      return { ok: false, status: 404, json: async () => ({}), text: async () => "nope" } as unknown as Response;
    }) as typeof fetch;
    return { calls, client: new GoogleSheetsClient({ credentials: SA, spreadsheetId: "SHEET1", fetchImpl }) };
  }
  it("signs in once, then reads the tab id and values and posts a batch", async () => {
    const { calls, client } = stub();
    expect(await client.sheetIdByTitle("[AUTOMATION]WEEKLY JOB SHEET")).toBe(1204945400);
    expect(await client.sheetIdByTitle("nope")).toBeNull();
    expect(await client.getValues(a1("[AUTOMATION]WEEKLY JOB SHEET", "A1:HZ"))).toEqual([["Town/Address/Customer", "PIF"], ["9/7/2026-9/13/2026"]]);
    await client.batchUpdate([{ a: 1 }, { b: 2 }]);
    expect(calls.filter((c) => c.url.endsWith("/token"))).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer" });
    expect(calls.slice(1).every((c) => c.auth === "Bearer tok-1")).toBe(true);
    const values = calls.find((c) => c.url.includes("/values/"))!;
    expect(values.url).toContain(encodeURIComponent("'[AUTOMATION]WEEKLY JOB SHEET'!A1:HZ"));
    expect(values.url).toContain("valueRenderOption=UNFORMATTED_VALUE");
    const batch = calls.find((c) => c.url.endsWith(":batchUpdate"))!;
    expect(batch.method).toBe("POST");
    expect(batch.body).toEqual({ requests: [{ a: 1 }, { b: 2 }], includeSpreadsheetInResponse: false });
  });
  it("explains a 403 as a sharing problem", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/token")) return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }), text: async () => "" } as unknown as Response;
      return { ok: false, status: 403, json: async () => ({}), text: async () => "The caller does not have permission" } as unknown as Response;
    }) as typeof fetch;
    const client = new GoogleSheetsClient({ credentials: SA, spreadsheetId: "SHEET1", fetchImpl });
    await expect(client.getValues("'x'!A1")).rejects.toThrow(/shared with the service account/);
  });
});
