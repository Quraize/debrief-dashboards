/**
 * JobProgress client.
 *
 * Exercised against a stub that reproduces the response shapes documented in
 * docs/jobprogress-api.md — including the ones the Base44 client got wrong.
 * Each test below maps to a specific defect recorded there, so a regression
 * points straight at the evidence.
 */
import { describe, it, expect, vi } from "vitest";
import {
  JobProgressClient, JobProgressError, unwrap, unwrapMany, hasResult,
} from "../src/integrations/jobprogress/client.js";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";

/** A limiter that never waits — pacing is tested in rateLimiter.test.ts. */
const noWaitLimiter = () =>
  new RateLimiter({ limit: 1e9, windowMs: 1, now: () => Date.now(), sleep: async () => {} });

/** Builds a fetch stub returning canned pages, and records the URLs requested. */
function stubFetch(handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(String(url));
    const { status = 200, body = {}, headers = {} } = handler(String(url));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const page = (data: unknown[], totalPages = 1) => ({ data, meta: { pagination: { total_pages: totalPages } } });

const client = (fetchImpl: typeof fetch, onStat?: never) =>
  new JobProgressClient({
    token: "test-token", baseUrl: "https://api.test/v3",
    limiter: noWaitLimiter(), fetchImpl, sleep: async () => {}, onStat,
  });

describe("relation unwrapping (docs §2.3)", () => {
  // The old client unwrapped `jobs.data` but read `customer`, `user` and
  // `created_by` directly — so if the wrapper is uniform, every contact and rep
  // field imported blank. These helpers make the shape irrelevant to callers.
  it("unwraps a single relation from .data", () => {
    expect(unwrap({ data: { id: 1, name: "Acme" } })).toEqual({ id: 1, name: "Acme" });
  });

  it("accepts an already-unwrapped object", () => {
    expect(unwrap({ id: 1, name: "Acme" })).toEqual({ id: 1, name: "Acme" });
  });

  it("takes the first element when a single relation arrives as a collection", () => {
    expect(unwrap({ data: [{ id: 1 }, { id: 2 }] })).toEqual({ id: 1 });
  });

  it("returns null for an absent relation or a non-object", () => {
    for (const v of [null, undefined, 42, "x", true]) {
      expect(unwrap(v as unknown), `unwrap(${JSON.stringify(v)})`).toBeNull();
    }
  });

  it("returns null when the wrapper is present but empty", () => {
    expect(unwrap({ data: null })).toBeNull();
    expect(unwrap({ data: [] })).toBeNull();
  });

  it("passes through an empty object as an empty relation, not an absent one", () => {
    // {} is present-but-empty, which is different from absent. Callers read
    // fields off it and get undefined either way, so preserving the distinction
    // costs nothing and keeps `unwrap` honest about what the API returned.
    expect(unwrap({})).toEqual({});
  });

  it("unwraps collections in either shape", () => {
    expect(unwrapMany({ data: [{ id: 1 }, { id: 2 }] })).toHaveLength(2);
    expect(unwrapMany([{ id: 1 }])).toHaveLength(1);
    expect(unwrapMany(null)).toEqual([]);
    expect(unwrapMany({ data: { id: 1 } }), "a single object becomes a one-item list").toHaveLength(1);
  });
});

describe("appointment results (docs §2.2)", () => {
  it("reads result_option_ids, the field that actually exists", () => {
    expect(hasResult({ result_option_ids: [13] })).toBe(true);
    expect(hasResult({ result_option_ids: [] })).toBe(false);
  });

  it("ignores the singular form, which is only a query parameter", () => {
    // The old client tested `result_option_id`, so it was always undefined and
    // the "results available" counter was wrong.
    expect(hasResult({ result_option_id: 13 })).toBe(false);
  });

  it("still honours the result array", () => {
    expect(hasResult({ result: [{ id: 1 }] })).toBe(true);
    expect(hasResult({})).toBe(false);
  });
});

describe("pagination", () => {
  it("walks every page and concatenates", async () => {
    const { impl, calls } = stubFetch((url) => {
      const p = Number(new URL(url).searchParams.get("page"));
      return { body: page([{ id: p * 10 }, { id: p * 10 + 1 }], 3) };
    });
    const rows = await client(impl).listDivisions();
    expect(rows).toHaveLength(6);
    expect(calls).toHaveLength(3);
  });

  it("requests a stable sort, so rows cannot shift between pages", async () => {
    // Without an explicit order, records written while we page can move and be
    // returned twice or skipped — the same hazard the entity API guards against.
    const { impl, calls } = stubFetch(() => ({ body: page([{ id: 1 }]) }));
    await client(impl).listDivisions();
    expect(calls[0]).toContain("sort_by=id");
    expect(calls[0]).toContain("sort_order=asc");
  });

  it("uses the documented maximum page size", async () => {
    const { impl, calls } = stubFetch(() => ({ body: page([]) }));
    await client(impl).listDivisions();
    expect(calls[0]).toContain("limit=100");
  });

  it("repeats array parameters rather than joining them", async () => {
    // includes[]=a&includes[]=b — a comma-joined value is silently ignored.
    const { impl, calls } = stubFetch(() => ({ body: page([]) }));
    await client(impl).listDivisions();
    const url = calls[0]!;
    expect(url.match(/includes%5B%5D=/g) ?? url.match(/includes\[\]=/g)).toHaveLength(2);
  });
});

describe("incremental sync (docs §3.1)", () => {
  it("filters on appointment_updated_date, not the occurrence date", async () => {
    // The whole point: a result added today to an appointment held weeks ago
    // is invisible to an occurrence-date query.
    const { impl, calls } = stubFetch(() => ({ body: page([]) }));
    await client(impl).listAppointmentsUpdatedSince("2026-08-01 00:00:00", "2026-08-30 23:59:59");
    expect(calls[0]).toContain("date_range_type=appointment_updated_date");
  });

  it("still supports an occurrence-date backfill", async () => {
    const { impl, calls } = stubFetch(() => ({ body: page([]) }));
    await client(impl).listAppointmentsByDate("2026-07-01", "2026-07-31");
    expect(calls[0]).toContain("duration=date");
  });
});

describe("signed sales (docs §3.2)", () => {
  it("queries contract_signed_date directly instead of testing every job", async () => {
    const { impl, calls } = stubFetch(() => ({ body: page([{ id: 1 }]) }));
    const jobs = await client(impl).listJobsSignedBetween("2026-08-01", "2026-08-31");
    expect(calls[0]).toContain("date_range_type=contract_signed_date");
    expect(jobs).toHaveLength(1);
  });
});

describe("batching", () => {
  it("splits job ids into batches to keep URLs bounded", async () => {
    const { impl, calls } = stubFetch(() => ({ body: page([{ id: 1 }]) }));
    await client(impl).listJobsByIds(Array.from({ length: 45 }, (_, i) => i + 1), 20);
    expect(calls).toHaveLength(3); // 20 + 20 + 5
  });

  it("makes no request for an empty id list", async () => {
    const { impl, calls } = stubFetch(() => ({ body: page([]) }));
    await client(impl).listJobsByIds([]);
    expect(calls).toHaveLength(0);
  });
});

describe("failure handling", () => {
  it("retries a 500 and then succeeds", async () => {
    let n = 0;
    const { impl } = stubFetch(() => (++n < 3 ? { status: 500 } : { body: page([{ id: 1 }]) }));
    const rows = await client(impl).listDivisions();
    expect(rows).toHaveLength(1);
    expect(n).toBe(3);
  });

  it("honours Retry-After on a 429", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const { impl } = stubFetch(() =>
      ++n === 1 ? { status: 429, headers: { "retry-after": "7" } } : { body: page([{ id: 1 }]) });
    const c = new JobProgressClient({
      token: "t", baseUrl: "https://api.test/v3", limiter: noWaitLimiter(),
      fetchImpl: impl, sleep: async (ms) => { sleeps.push(ms); },
    });
    await c.listDivisions();
    expect(sleeps[0], "should wait the server-specified 7 seconds").toBe(7000);
  });

  it("explains a 401 rather than surfacing a bare status", async () => {
    const { impl } = stubFetch(() => ({ status: 401 }));
    await expect(client(impl).listDivisions()).rejects.toThrow(/token missing, invalid or expired/i);
  });

  it("explains a 403 as a permissions problem", async () => {
    const { impl } = stubFetch(() => ({ status: 403 }));
    await expect(client(impl).listDivisions()).rejects.toThrow(/admin-generated token/i);
  });

  it("gives up after the retry budget and reports the endpoint", async () => {
    const { impl } = stubFetch(() => ({ status: 500 }));
    await expect(client(impl).listDivisions()).rejects.toMatchObject({
      name: "JobProgressError", status: 500, endpoint: "divisions",
    });
  });

  it("retries a network failure before giving up", async () => {
    let n = 0;
    const impl = (async () => {
      if (++n < 3) throw new Error("ECONNRESET");
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => page([{ id: 1 }]) } as unknown as Response;
    }) as unknown as typeof fetch;
    const rows = await client(impl).listDivisions();
    expect(rows).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("refuses to construct without a token, and says where to get one", () => {
    const saved = process.env.LEAP_API_TOKEN;
    delete process.env.LEAP_API_TOKEN;
    try {
      expect(() => new JobProgressClient()).toThrow(/Settings -> Developer/);
    } finally {
      if (saved !== undefined) process.env.LEAP_API_TOKEN = saved;
    }
  });

  it("sends the token as a Bearer credential", async () => {
    const seen: Record<string, string>[] = [];
    const impl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => page([]) } as unknown as Response;
    }) as unknown as typeof fetch;
    await client(impl).listDivisions();
    expect(seen[0]!.Authorization).toBe("Bearer test-token");
  });

  it("reports counters for the sync telemetry", async () => {
    const stats: string[] = [];
    let n = 0;
    const { impl } = stubFetch(() => (++n === 1 ? { status: 500 } : { body: page([]) }));
    const c = new JobProgressClient({
      token: "t", baseUrl: "https://api.test/v3", limiter: noWaitLimiter(),
      fetchImpl: impl, sleep: async () => {},
      onStat: (s) => stats.push(s),
    });
    await c.listDivisions();
    expect(stats).toContain("request");
    expect(stats).toContain("retry");
  });
});

describe("every call is rate limited", () => {
  it("acquires from the limiter before each request", async () => {
    // The defect this rewrite exists to fix: the old client paced itself at
    // 300 req/min against a documented 60.
    const limiter = noWaitLimiter();
    const spy = vi.spyOn(limiter, "acquire");
    const { impl } = stubFetch(() => ({ body: page([{ id: 1 }], 2) }));
    const c = new JobProgressClient({
      token: "t", baseUrl: "https://api.test/v3", limiter, fetchImpl: impl, sleep: async () => {},
    });
    await c.listDivisions();
    expect(spy).toHaveBeenCalledTimes(2); // once per page
  });
});
