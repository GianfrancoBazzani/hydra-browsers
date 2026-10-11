import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

const SWEEP_EVERY = 1000;

/** 429 rate_limited. `api/errors.ts` sends `Retry-After` with `retryAfterSeconds`. */
export class RateLimitedError extends HydraError {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number, message = 'Too many requests. Try again later.') {
    super('rate_limited', message);
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  }
}

/**
 * Sliding window limit in memory: at most `limit` takes per key in any `windowMs`.
 * Used for the login limit per IP (spec section 6.4) and the token limit (spec section 6.6).
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #hits = new Map<string, number[]>();
  #calls = 0;

  constructor(options: { limit: number; windowMs: number; clock: Clock }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock;
  }

  /** Counts one request for the key. Returns false if the key is over the limit. */
  take(key: string): boolean {
    const now = this.#clock.now();
    this.#sweep(now);
    const hits = this.#recent(key, now);
    if (hits.length >= this.#limit) {
      this.#hits.set(key, hits);
      return false;
    }
    hits.push(now);
    this.#hits.set(key, hits);
    return true;
  }

  /** Milliseconds until `take(key)` can succeed again. 0 if it can succeed now. */
  retryAfterMs(key: string): number {
    const now = this.#clock.now();
    const hits = this.#recent(key, now);
    if (hits.length < this.#limit) return 0;
    const oldest = hits[hits.length - this.#limit] ?? now;
    return oldest + this.#windowMs - now;
  }

  #recent(key: string, now: number): number[] {
    const start = now - this.#windowMs;
    return (this.#hits.get(key) ?? []).filter((time) => time > start);
  }

  #sweep(now: number): void {
    this.#calls += 1;
    if (this.#calls % SWEEP_EVERY !== 0) return;
    for (const [key, hits] of this.#hits) {
      const newest = hits[hits.length - 1];
      if (newest === undefined || newest <= now - this.#windowMs) this.#hits.delete(key);
    }
  }
}
