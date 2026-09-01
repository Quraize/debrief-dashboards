/**
 * Rate limiter.
 *
 * This is the fix for a live defect, so the tests are about the property that
 * was violated: never more than N requests inside any window. Virtual time is
 * used throughout — a test that actually waits a minute is a test nobody runs.
 */
import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/integrations/jobprogress/rateLimiter.js";

/**
 * A controllable clock. `sleep` jumps time forward rather than waiting, so a
 * full 60-second window costs microseconds.
 */
function virtualClock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => { t += ms; },
    advance: (ms: number) => { t += ms; },
    get time() { return t; },
  };
}

describe("RateLimiter", () => {
  it("lets the first N requests through without waiting", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    const started = clock.time;
    for (let i = 0; i < 5; i++) await limiter.acquire();
    expect(clock.time, "no waiting should be needed under the limit").toBe(started);
  });

  it("delays the request that would exceed the window", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ limit: 5, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 5; i++) await limiter.acquire();

    const before = clock.time;
    await limiter.acquire(); // the 6th
    expect(clock.time - before, "should wait out the window").toBeGreaterThanOrEqual(60_000);
  });

  it("never exceeds the limit in ANY sliding window", async () => {
    // The actual invariant. A token bucket with a burst allowance passes a naive
    // "60 in the first minute" check and still breaks this.
    const clock = virtualClock();
    const LIMIT = 10, WINDOW = 60_000;
    const limiter = new RateLimiter({ limit: LIMIT, windowMs: WINDOW, now: clock.now, sleep: clock.sleep });

    const timestamps: number[] = [];
    for (let i = 0; i < 40; i++) {
      await limiter.acquire();
      timestamps.push(clock.time);
    }

    for (const t of timestamps) {
      const inWindow = timestamps.filter((x) => x > t - WINDOW && x <= t).length;
      expect(inWindow, `window ending at ${t} held ${inWindow} requests`).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("lets requests through again as older ones age out", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ limit: 3, windowMs: 10_000, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 3; i++) await limiter.acquire();

    clock.advance(10_001); // the whole window has passed
    const before = clock.time;
    await limiter.acquire();
    expect(clock.time, "an expired window should not cost a wait").toBe(before);
  });

  it("holds the limit under concurrent callers", async () => {
    // The check-then-act race: without serialising waiters, every concurrent
    // caller observes a free slot at the same instant and all proceed.
    const clock = virtualClock();
    const LIMIT = 5, WINDOW = 60_000;
    // Recorded via onIssue, not after `await acquire()`: a caller's `.then`
    // runs in a later microtask, by which point another waiter has already
    // advanced virtual time, so the observed times would not be issue times.
    const times: number[] = [];
    const tracked = new RateLimiter({
      limit: LIMIT, windowMs: WINDOW, now: clock.now, sleep: clock.sleep,
      onIssue: (t) => times.push(t),
    });
    await Promise.all(Array.from({ length: 20 }, () => tracked.acquire()));

    for (const t of times) {
      const inWindow = times.filter((x) => x > t - WINDOW && x <= t).length;
      expect(inWindow).toBeLessThanOrEqual(LIMIT);
    }
  });

  it("reports how much of the window is used, for sync telemetry", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({ limit: 10, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    await limiter.acquire();
    await limiter.acquire();
    expect(limiter.inFlightWindow).toBe(2);
    clock.advance(60_001);
    expect(limiter.inFlightWindow, "expired entries should not count").toBe(0);
  });

  it("defaults below the documented 60/min", () => {
    // The margin is deliberate: our accounting and the server's will not agree
    // perfectly, and a 429 storm mid-sync costs far more than a few requests.
    const limiter = new RateLimiter();
    expect((limiter as unknown as { limit: number }).limit).toBeLessThanOrEqual(60);
  });

  it("keeps working after a waiter rejects", async () => {
    const clock = virtualClock();
    const limiter = new RateLimiter({
      limit: 1, windowMs: 60_000, now: clock.now,
      sleep: async () => { throw new Error("interrupted"); },
    });
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow("interrupted");

    // A rejection must not poison the chain for everyone behind it.
    clock.advance(60_001);
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });
});
