/**
 * Sliding-window rate limiter for the JobProgress API.
 *
 * The vendor documents **60 requests per minute**, then 429. The Base44 client
 * paced itself with a flat 200ms delay — 300 requests a minute, five times the
 * limit. Its exponential backoff hid this: the sync appeared to work while being
 * throttled continuously, so the defect only shows up as unexplained slowness.
 *
 * A sliding window is used rather than a token bucket because it maps exactly
 * onto how the limit is expressed. A bucket with capacity C refilling at 1/s
 * still permits C + 60 requests inside some 60-second window; a sliding window
 * permits precisely N per window, by construction.
 *
 * One instance is shared across every JobProgress call — appointments, jobs,
 * divisions and financial summaries all draw on the same server-side budget, so
 * per-endpoint limiters would collectively exceed it.
 */

export interface RateLimiterOptions {
  /** Requests permitted per window. Defaults below the documented 60. */
  limit?: number;
  /** Window length in milliseconds. */
  windowMs?: number;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
  /** Injectable for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Called with the timestamp each time a request is issued.
   *
   * Exists because the moment a request is *issued* is the only thing the limit
   * is defined over, and it cannot be observed reliably from outside: a caller
   * recording the time after `await acquire()` does so in a later microtask, by
   * which point another waiter may have moved the clock. Also a natural hook for
   * telemetry.
   */
  onIssue?: (issuedAt: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onIssue: ((issuedAt: number) => void) | undefined;

  /** Timestamps of issued requests, oldest first. Trimmed as they age out. */
  private issued: number[] = [];

  /**
   * Serialises waiters. Without it, ten callers all see a free slot at the same
   * moment and all proceed — the classic check-then-act race that makes a
   * limiter look correct in a unit test and fail under concurrency.
   */
  private tail: Promise<void> = Promise.resolve();

  constructor(options: RateLimiterOptions = {}) {
    // 55 rather than 60 by default: the server's accounting and ours will not
    // agree perfectly, and the cost of a small margin is far lower than the cost
    // of a 429 storm mid-sync.
    this.limit = options.limit ?? Number(process.env.LEAP_RATE_LIMIT ?? 55);
    this.windowMs = options.windowMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.onIssue = options.onIssue;
  }

  /** Resolves when it is safe to issue a request, recording it as issued. */
  async acquire(): Promise<void> {
    const mine = this.tail.then(() => this.reserve());
    // Swallow on the chain so one rejection cannot poison every later waiter.
    this.tail = mine.catch(() => {});
    return mine;
  }

  private async reserve(): Promise<void> {
    for (;;) {
      const cutoff = this.now() - this.windowMs;
      this.issued = this.issued.filter((t) => t > cutoff);

      if (this.issued.length < this.limit) {
        const at = this.now();
        this.issued.push(at);
        this.onIssue?.(at);
        return;
      }

      // Wait until the oldest request leaves the window. +1ms so the boundary
      // case cannot spin.
      const waitMs = this.issued[0]! + this.windowMs - this.now() + 1;
      await this.sleep(Math.max(waitMs, 1));
    }
  }

  /** Requests issued in the current window — for sync telemetry. */
  get inFlightWindow(): number {
    const cutoff = this.now() - this.windowMs;
    return this.issued.filter((t) => t > cutoff).length;
  }

  /** Test/diagnostic hook. */
  reset(): void {
    this.issued = [];
    this.tail = Promise.resolve();
  }
}

/**
 * The single limiter every JobProgress call goes through.
 * Exported as a getter so tests can supply their own without module surgery.
 */
let shared: RateLimiter | undefined;
export function jobProgressLimiter(): RateLimiter {
  shared ??= new RateLimiter();
  return shared;
}
export function setJobProgressLimiter(limiter: RateLimiter): void {
  shared = limiter;
}
