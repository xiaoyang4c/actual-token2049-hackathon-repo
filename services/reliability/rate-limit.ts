/**
 * @fileoverview A fixed-window request limit per key, in memory. It slows
 * guessing and flooding on the wallet sign-in and account routes. A restart
 * clears it.
 */

export class RateLimiter {
  private readonly hits = new Map<string, {start: number; count: number}>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Counts one request. Returns the seconds to wait, or 0 when the request may go on. */
  take(key: string): number {
    const now = this.now();
    if (this.hits.size > 10_000) {
      for (const [k, entry] of this.hits) if (now - entry.start >= this.windowMs) this.hits.delete(k);
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
