/**
 * @fileoverview A fixed-window request limit per key, in memory. It slows
 * guessing and flooding on the wallet sign-in and account routes. A restart
 * clears it.
 *
 * The map holds at most `maxKeys` keys. When it is full, expired keys are
 * swept at most once per tenth of a window, and then the oldest key is
 * dropped for a new one. A flood of new keys therefore costs constant time
 * per request and cannot grow the map.
 */

export class RateLimiter {
  private readonly hits = new Map<string, {start: number; count: number}>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts one request. Returns the seconds to wait, or 0 when the request may go on. */
  take(key: string): number {
    const now = this.now();
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      if (now - this.lastSweep >= this.windowMs / 10) {
        this.lastSweep = now;
        for (const [k, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(k);
      }
      if (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value;
        if (oldest !== undefined) this.hits.delete(oldest);
      }
    }
    const entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      this.hits.set(key, {start: now, count: 1});
      return 0;
    }
    if (entry.count >= this.limit) return Math.ceil((entry.start + this.windowMs - now) / 1000);
    entry.count++;
    return 0;
  }
}
