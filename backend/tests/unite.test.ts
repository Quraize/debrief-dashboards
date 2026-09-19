/**
 * Intermedia Unite client + connection probe, against a fake identity server
 * and API. No network, no database.
 */
import { describe, it, expect } from "vitest";
import { UniteClient, uniteConfig, SCOPES, iso } from "../src/integrations/intermedia/client.js";
import { probeUnite } from "../src/integrations/intermedia/probe.js";

const CFG = { clientId: "id-1", clientSecret: "s3cret", tokenUrl: "https://login.test/token", apiBase: "https://api.test" };

function fakeUnite(opts: { failScope?: string; noAudio?: boolean } = {}) {
  const log: { url: string; method: string; auth: string | null; body: string | null }[] = [];
  let tokenCalls = 0;
  const json = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data, text: async () => JSON.stringify(data) }) as unknown as Response;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? String(init.body) : null;
    log.push({ url: u, method: init?.method ?? "GET", auth: headers["Authorization"] ?? null, body });
    if (u === CFG.tokenUrl) {
      tokenCalls++;
      const scope = new URLSearchParams(body ?? "").get("scope") ?? "";
      if (scope === opts.failScope) return json({ error: "invalid_scope" }, 400);
      return json({ access_token: `tok-${scope}`, expires_in: 3600, token_type: "Bearer", scope });
    }
    if (u.includes("/address-book/v3/accounts/_me/contacts")) {
      return json({ results: [
        { id: "u-jason", type: "user", displayName: "Jason Malarchak", email: "j@x", phoneNumbers: [{ type: "Phone", number: "+1 201 555 0100", internationalFormatNumber: "+12015550100" }], pbx: { enabled: true, extension: "408" } },
        { id: "u-ashley", type: "user", displayName: "Ashley Pascual", email: "a@x", phoneNumbers: [], pbx: { enabled: true, extension: "404" } },
        { id: "u-aa", type: "user", displayName: "Allied AA Day", email: null, phoneNumbers: [], pbx: { enabled: true, extension: "500" } },
        { id: "room-1", type: "room", displayName: "Conference Room", email: null, phoneNumbers: [], pbx: null },
      ] });
    }
    if (u.includes("/analytics/calls/call/detail")) {
      const offset = Number(new URL(u).searchParams.get("offset"));
      const calls = offset === 0 ? [
        { id: "c1", globalCallId: "g1", start: "2026-09-17T14:02:11Z", duration: 312, direction: "inbound", from: { number: "+12015550134", name: "CUSTOMER", userUniqueId: null, device: null }, to: { number: "408", name: "Jason Malarchak", userUniqueId: "u-jason", device: { deviceType: "pbx" } }, group: null },
        { id: "c2", globalCallId: "g2", start: "2026-09-17T15:30:00Z", duration: 45, direction: "outbound", from: { number: "408", name: "Jason Malarchak", userUniqueId: "u-jason", device: null }, to: { number: "+19735550100", name: null, userUniqueId: null, device: null }, group: null },
        { id: "c3", globalCallId: "g3", start: "2026-09-17T16:00:00Z", duration: 20, direction: "internal", from: { number: "408", name: "Jason", userUniqueId: "u-jason", device: null }, to: { number: "404", name: "Ashley", userUniqueId: "u-ashley", device: null }, group: null },
      ] : [];
      return json({ calls, totalCalls: 3 });
    }
    if (u.endsWith("/_content")) {
      if (opts.noAudio) return json({ title: "forbidden" }, 403);
      const bytes = new Uint8Array(4096);
      return { ok: true, status: 206, headers: new Headers({ "content-type": "audio/mpeg" }), arrayBuffer: async () => bytes.buffer, text: async () => "" } as unknown as Response;
    }
    if (u.includes("/call-recordings")) {
      if (u.includes("/u-aa/")) return json({ records: [] });
      return json({ records: [{ id: 9001, fileName: "x/y/2026_Sep_17.mp3", duration: 312, callId: "g1", whenCreated: "2026-09-17T14:07:23+00:00", direction: "incoming", wasPaused: false, status: "active", caller: { phoneNumber: "2015550134", displayName: "CUSTOMER" } }] });
    }
    return json({ title: "not found" }, 404);
  }) as typeof fetch;
  return { fetchImpl, log, tokenCalls: () => tokenCalls };
}

describe("uniteConfig", () => {
  it("needs both halves of the credential and defaults the URLs", () => {
    expect(uniteConfig({})).toMatchObject({ configured: false, reason: "INTERMEDIA_CLIENT_ID not set" });
    expect(uniteConfig({ INTERMEDIA_CLIENT_ID: "a" })).toMatchObject({ configured: false, reason: "INTERMEDIA_CLIENT_SECRET not set" });
    // compose passes unset variables as "": that must mean the vendor's defaults.
    const c = uniteConfig({ INTERMEDIA_CLIENT_ID: "a", INTERMEDIA_CLIENT_SECRET: "b", INTERMEDIA_TOKEN_URL: "", INTERMEDIA_API_BASE: "https://api.intermedia.net/" });
    expect(uniteConfig({ INTERMEDIA_CLIENT_ID: "a", INTERMEDIA_CLIENT_SECRET: "b", INTERMEDIA_TOKEN_URL: "", INTERMEDIA_API_BASE: "" }).config)
      .toMatchObject({ tokenUrl: "https://login.intermedia.net/user/connect/token", apiBase: "https://api.intermedia.net" });
    expect(c.configured).toBe(true);
    expect(c.config).toMatchObject({ tokenUrl: "https://login.intermedia.net/user/connect/token", apiBase: "https://api.intermedia.net" });
    expect(iso(new Date("2026-09-17T00:00:00Z"))).toBe("2026-09-17T00:00:00.000Z");
  });
});

describe("UniteClient", () => {
  it("exchanges the credential for one token per scope, as a form post, and caches it", async () => {
    const fake = fakeUnite();
    const client = new UniteClient(CFG, { fetchImpl: fake.fetchImpl });
    await client.listAccountContacts();
    await client.listAccountContacts();
    await client.listCallDetails(new Date("2026-09-17T00:00:00Z"), new Date("2026-09-18T00:00:00Z"));
    expect(fake.tokenCalls()).toBe(2); // address-book once (cached on the 2nd call), analytics once
    const tokenReq = fake.log.find((l) => l.url === CFG.tokenUrl)!;
    const form = new URLSearchParams(tokenReq.body ?? "");
    expect(Object.fromEntries(form)).toEqual({ grant_type: "client_credentials", client_id: "id-1", client_secret: "s3cret", scope: SCOPES.addressBook });
    const contacts = fake.log.find((l) => l.url.includes("/address-book/"))!;
    expect(contacts.auth).toBe(`Bearer tok-${SCOPES.addressBook}`);
    const detail = fake.log.find((l) => l.url.includes("/analytics/calls/call/detail"))!;
    expect(detail.method).toBe("POST");
    expect(detail.auth).toBe(`Bearer tok-${SCOPES.analytics}`);
    const q = new URL(detail.url).searchParams;
    expect(q.get("dateFrom")).toBe("2026-09-17T00:00:00.000Z");
    expect(q.get("dateTo")).toBe("2026-09-18T00:00:00.000Z");
    expect(q.get("size")).toBe("500");
  });

  it("names the scope when the identity server refuses it, without the secret", async () => {
    const fake = fakeUnite({ failScope: SCOPES.recordings });
    const client = new UniteClient(CFG, { fetchImpl: fake.fetchImpl });
    await expect(client.listCallRecordings("u-jason")).rejects.toMatchObject({ name: "UniteError", status: 400, endpoint: "token" });
    await expect(client.listCallRecordings("u-jason")).rejects.toThrow(/api\.service\.voice\.call-recordings/);
    await expect(client.listCallRecordings("u-jason")).rejects.not.toThrow(/s3cret/);
  });
});

describe("probeUnite", () => {
  it("reports each API, the users with extensions, yesterday's calls and one user's recordings — numbers masked", async () => {
    const fake = fakeUnite();
    const client = new UniteClient(CFG, { fetchImpl: fake.fetchImpl });
    const r = await probeUnite({ env: { INTERMEDIA_CLIENT_ID: "id-1", INTERMEDIA_CLIENT_SECRET: "s3cret" }, client, now: new Date("2026-09-18T13:00:00Z") });
    expect(r.configured).toBe(true);
    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.users).toMatchObject({ total: 4, withExtension: 3 });
    expect(r.users.sample[0]).toEqual({ name: "Jason Malarchak", extension: "408" });
    expect(r.calls).toMatchObject({ window: "2026-09-17 (UTC day)", total: 3, inbound: 1, outbound: 1, internal: 1, matchableNumbers: 2 });
    expect(r.calls.sample[0]).toEqual({ start: "2026-09-17T14:02:11Z", direction: "inbound", from: "(201) •••-0134", to: "408…", seconds: 312 });
    expect(r.recordings).toEqual({ user: "Jason Malarchak", listed: 1, newest: "2026-09-17T14:07:23+00:00" });
    // The download is what decides Phases 2 and 3: proven with a ranged request, never the whole file.
    expect(r.audio).toMatchObject({ tried: true, ok: true, status: 206, contentType: "audio/mpeg", bytes: 4096 });
    expect(fake.log.find((l) => l.url.endsWith("/_content"))!.url).toContain("/users/u-jason/call-recordings/9001/_content");
    expect(r.autoAttendant).toMatchObject({ user: "Allied AA Day", listed: 0 });
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(JSON.stringify(r)).not.toContain("2015550134");
  });

  it("says why when not configured, and keeps going past a refused scope", async () => {
    expect(await probeUnite({ env: {} })).toMatchObject({ configured: false, reason: "INTERMEDIA_CLIENT_ID not set", steps: [] });
    const fake = fakeUnite({ failScope: SCOPES.analytics });
    const r = await probeUnite({ env: { INTERMEDIA_CLIENT_ID: "id-1", INTERMEDIA_CLIENT_SECRET: "s3cret" }, client: new UniteClient(CFG, { fetchImpl: fake.fetchImpl }), now: new Date("2026-09-18T13:00:00Z") });
    const failed = r.steps.filter((s) => !s.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ name: "Sign in — Analytics" });
    expect(r.recordings.listed).toBe(1); // the recordings check still ran
  });

  it("reports a refused audio download as its own failed step, not a crash", async () => {
    const fake = fakeUnite({ noAudio: true });
    const r = await probeUnite({ env: { INTERMEDIA_CLIENT_ID: "id-1", INTERMEDIA_CLIENT_SECRET: "s3cret" }, client: new UniteClient(CFG, { fetchImpl: fake.fetchImpl }), now: new Date("2026-09-18T13:00:00Z") });
    expect(r.audio).toMatchObject({ tried: true, ok: false, status: 403 });
    expect(r.steps.find((s) => s.name === "Download recording audio")).toMatchObject({ ok: false });
    expect(r.recordings.listed).toBe(1);
  });
});
