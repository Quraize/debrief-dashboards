/**
 * JobProgress / Leap API client.
 *
 * A rewrite, not a port (D14). The vendor spec contradicted several assumptions
 * in the Base44 implementation — see docs/jobprogress-api.md for the evidence
 * behind each of the following:
 *
 *   * §2.1  the old client ran at 300 req/min against a documented 60. Every
 *           call here goes through the shared sliding-window limiter.
 *   * §2.2  the appointment field is `result_option_ids` (plural). The singular
 *           form is only a query parameter, so the old result counts were wrong.
 *   * §2.3  included relations come back wrapped in `.data`. The old client
 *           unwrapped `jobs` but read `customer`, `user` and `created_by`
 *           directly, so contact and rep fields may have imported blank.
 *   * §3.1  `date_range_type=appointment_updated_date` gives a real incremental
 *           sync. Polling a fixed occurrence-date window cannot see a result
 *           added today to an appointment held three weeks ago.
 *   * §3.2  `date_range_type=contract_signed_date` on /jobs returns signed sales
 *           directly, instead of fetching every job and testing each one.
 */
import { RateLimiter, jobProgressLimiter } from "./rateLimiter.js";

const BASE_URL = process.env.LEAP_API_BASE ?? "https://api.jobprogress.com/api/v3";
const MAX_PAGE = 100;        // documented maximum
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

export class JobProgressError extends Error {
  constructor(message: string, readonly status: number | null, readonly endpoint: string) {
    super(message);
    this.name = "JobProgressError";
  }
}

export interface Pagination {
  total: number; count: number; per_page: number;
  current_page: number; total_pages: number;
}

export interface ClientOptions {
  token?: string;
  baseUrl?: string;
  limiter?: RateLimiter;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Counters surfaced on the SyncRun row. */
  onStat?: (stat: "request" | "retry" | "rateLimitHit" | "error", endpoint: string) => void;
}

/**
 * Unwraps a JSON:API-style relation.
 *
 * The API returns included relations as `{ data: … }`, and the shape differs by
 * relation — `jobs` is a collection, `customer` a single object. The Base44
 * client handled only the collection case, which is why single relations may
 * have silently read as undefined.
 */
export function unwrap<T = Record<string, unknown>>(relation: unknown): T | null {
  if (relation === null || relation === undefined) return null;
  if (typeof relation !== "object") return null;
  const maybe = relation as { data?: unknown };
  const inner = "data" in maybe ? maybe.data : relation;
  if (inner === null || inner === undefined) return null;
  if (Array.isArray(inner)) return (inner[0] ?? null) as T | null;
  return inner as T;
}

/** Same, for relations that are genuinely collections. */
export function unwrapMany<T = Record<string, unknown>>(relation: unknown): T[] {
  if (relation === null || relation === undefined) return [];
  if (Array.isArray(relation)) return relation as T[];
  if (typeof relation !== "object") return [];
  const inner = (relation as { data?: unknown }).data;
  return Array.isArray(inner) ? (inner as T[]) : inner ? [inner as T] : [];
}

/** True when an appointment carries a result. Uses the plural field (§2.2). */
export function hasResult(appointment: Record<string, unknown>): boolean {
  const ids = appointment["result_option_ids"];
  if (Array.isArray(ids) && ids.length > 0) return true;
  const result = appointment["result"];
  return Array.isArray(result) ? result.length > 0 : Boolean(result);
}

export class JobProgressClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly limiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onStat: ClientOptions["onStat"];

  constructor(options: ClientOptions = {}) {
    const token = options.token ?? process.env.LEAP_API_TOKEN;
    if (!token) {
      throw new Error(
        "LEAP_API_TOKEN is not set. Generate one in Leap under Settings -> Developer (admin only).",
      );
    }
    this.token = token;
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.limiter = options.limiter ?? jobProgressLimiter();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onStat = options.onStat;
  }

  private url(path: string, params: Record<string, string | number | string[] | undefined>): string {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        // The API expects repeated `includes[]=a&includes[]=b`, not a joined value.
        for (const v of value) qs.append(key, v);
      } else {
        qs.append(key, String(value));
      }
    }
    return `${this.baseUrl}${path}?${qs.toString()}`;
  }

  private async request<T>(
    url: string, endpoint: string,
    init: { method?: string; body?: URLSearchParams } = {},
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.limiter.acquire();
      this.onStat?.("request", endpoint);

      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method: init.method ?? "GET",
          body: init.body,
          headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
        });
      } catch (err) {
        if (attempt < MAX_RETRIES) {
          this.onStat?.("retry", endpoint);
          await this.sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        this.onStat?.("error", endpoint);
        throw new JobProgressError(`Network failure: ${(err as Error).message}`, null, endpoint);
      }

      if (res.status === 429) {
        // Should not happen now the limiter is correct — if it does, our
        // accounting disagrees with the server's and that is worth surfacing.
        this.onStat?.("rateLimitHit", endpoint);
        if (attempt < MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after")) * 1000;
          await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter
            : RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
      }

      if (res.status >= 500 && attempt < MAX_RETRIES) {
        this.onStat?.("retry", endpoint);
        await this.sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }

      if (!res.ok) {
        this.onStat?.("error", endpoint);
        // 401 and 403 are configuration problems, not transient ones — say so
        // rather than leaving someone to read a bare status code.
        const hint =
          res.status === 401 ? " (token missing, invalid or expired)"
          : res.status === 403 ? " (token lacks permission; Leap requires an admin-generated token)"
          : "";
        throw new JobProgressError(`HTTP ${res.status}${hint}`, res.status, endpoint);
      }

      return (await res.json()) as T;
    }
  }

  /**
   * Walks every page of a listing endpoint.
   *
   * `sort_by=id&sort_order=asc` is set explicitly: without a stable order,
   * records written while we page can shift between pages and be returned twice
   * or skipped entirely.
   */
  private async *paginate<T>(
    path: string, params: Record<string, string | number | string[] | undefined>, endpoint: string,
  ): AsyncGenerator<T[], void, unknown> {
    let page = 1;
    let totalPages = 1;
    do {
      const body = await this.request<{ data: T[]; meta?: { pagination?: Pagination } }>(
        this.url(path, { ...params, limit: MAX_PAGE, page, sort_by: "id", sort_order: "asc" }),
        endpoint,
      );
      const rows = body.data ?? [];
      totalPages = body.meta?.pagination?.total_pages ?? 1;
      if (rows.length > 0) yield rows;
      page += 1;
    } while (page <= totalPages);
  }

  private async collect<T>(
    path: string, params: Record<string, string | number | string[] | undefined>, endpoint: string,
  ): Promise<T[]> {
    const out: T[] = [];
    for await (const page of this.paginate<T>(path, params, endpoint)) out.push(...page);
    return out;
  }

  // ── Endpoints ──

  /** Divisions, for mapping a job's division_id to a name. */
  async listDivisions(): Promise<Record<string, unknown>[]> {
    return this.collect<Record<string, unknown>>("/divisions", { "includes[]": ["trades", "work_types"] }, "divisions");
  }

  /**
   * Appointments occurring in a date window. Used for a full backfill.
   * For routine syncing prefer `listAppointmentsUpdatedSince` — see §3.1.
   */
  async listAppointmentsByDate(from: string, to: string): Promise<Record<string, unknown>[]> {
    return this.collect<Record<string, unknown>>("/appointments", {
      duration: "date",
      start_date: `${from} 00:00:00`,
      end_date: `${to} 23:59:59`,
      with_job: "true",
      "includes[]": ["jobs", "result_option", "user", "attendees", "created_by", "customer"],
    }, "appointments");
  }

  /**
   * Appointments *modified* in a window — the correct basis for an incremental
   * sync. A result recorded today against an appointment held three weeks ago
   * appears here; it never appears in an occurrence-date query.
   */
  async listAppointmentsUpdatedSince(since: string, until: string): Promise<Record<string, unknown>[]> {
    return this.collect<Record<string, unknown>>("/appointments", {
      date_range_type: "appointment_updated_date",
      start_date: since,
      end_date: until,
      with_job: "true",
      "includes[]": ["jobs", "result_option", "user", "attendees", "created_by", "customer"],
    }, "appointments:updated");
  }

  /** Full job records for a set of ids, batched to keep URLs a sane length. */
  async listJobsByIds(ids: (string | number)[], batchSize = 20): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize).map(String);
      out.push(...await this.collect<Record<string, unknown>>("/jobs", {
        "job_ids[]": batch,
        "includes[]": ["division", "trades", "work_types", "reps", "estimators",
                       "financial_details", "insurance_details", "custom_fields"],
      }, "jobs:by-ids"));
    }
    return out;
  }

  /**
   * Jobs whose contract was signed in a window.
   *
   * Replaces the old approach of fetching every linked job and testing
   * `contract_signed_date` on each — one paginated query instead of N, which
   * also removes most of the calls that pushed the old client over the limit.
   */
  async listJobsSignedBetween(from: string, to: string): Promise<Record<string, unknown>[]> {
    return this.collect<Record<string, unknown>>("/jobs", {
      date_range_type: "contract_signed_date",
      start_date: from,
      end_date: to,
      "includes[]": ["division", "trades", "financial_details", "insurance_details"],
    }, "jobs:signed");
  }

  /** Financial summary for one job. Note the underscore in the path. */
  async financialSummary(jobId: string | number): Promise<Record<string, unknown> | null> {
    const body = await this.request<{ data?: unknown }>(
      `${this.baseUrl}/jobs/${jobId}/financial_summary`, "financial_summary");
    return unwrap(body.data ?? body);
  }

  /**
   * The filled result form for one appointment — the fields behind the
   * "Was it 2-Legs?" free-text answer. Used as a fallback: the appointment
   * listing usually carries `result` inline, and this call is only made when
   * `result_option_ids` says a result exists but the listing payload is empty.
   * Returns null when the appointment has no result (404).
   */
  async appointmentResult(appointmentId: string | number): Promise<unknown | null> {
    try {
      const body = await this.request<{ data?: unknown }>(
        `${this.baseUrl}/appointments/${appointmentId}/result`, "appointment_result");
      return body.data ?? body ?? null;
    } catch (err) {
      if (err instanceof JobProgressError && err.status === 404) return null;
      throw err;
    }
  }

  /**
   * A job's proposal documents. In Leap's UI this is the job's Proposals tab —
   * where Allied's signed contracts live. `job_id` is the supported filter
   * (`job_ids[]` is silently ignored by this endpoint — verified live).
   */
  async listProposals(jobId: string | number): Promise<Record<string, unknown>[]> {
    return this.collect<Record<string, unknown>>("/proposals", { job_id: String(jobId) }, "proposals");
  }

  /**
   * Downloads a proposal file. The `url` on a proposal is a pre-signed S3 link
   * (valid ~20 minutes), so this goes straight to storage: no auth header, and
   * deliberately NOT through the API rate limiter — S3 is not the CRM API.
   */
  async downloadFile(url: string): Promise<{ data: Buffer; contentType: string }> {
    const res = await this.fetchImpl(url);
    if (!res.ok) {
      throw new JobProgressError(`File download failed: HTTP ${res.status}`, res.status, "file_download");
    }
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  /**
   * Sets the Job Price on a job's financials — the field an approver fills in
   * manually today. The ONLY write this client performs; callers are expected
   * to have verified the job has no price yet.
   */
  async updateJobPrice(jobId: string | number, amount: number): Promise<void> {
    await this.request(
      `${this.baseUrl}/jobs/${jobId}/financials/price`,
      "update_price",
      { method: "PUT", body: new URLSearchParams({ amount: String(amount) }) },
    );
  }

  /** Cheap authenticated call, for the connection check in the admin UI. */
  async verifyConnection(): Promise<{ ok: true; status: number }> {
    await this.request(this.url("/divisions", { limit: 1 }), "verify");
    return { ok: true, status: 200 };
  }
}
