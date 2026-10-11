import type { Clock } from '../lib/clock.js';

/** Failures without a wait. The wait starts after the 5th failure (spec section 6.4). */
export const THROTTLE_FREE_FAILURES = 5;
export const THROTTLE_FIRST_WAIT_MS = 15 * 60 * 1000;
export const THROTTLE_MAX_WAIT_MS = 24 * 60 * 60 * 1000;

const SWEEP_EVERY = 1000;

interface ThrottleEntry {
  failures: number;
  waitUntil: number;
  lastFailureAt: number;
}

/** Wait after `failures` failures in a row: 0 before the 5th, then 15 min doubling, max 24 h. */
export function throttleWaitMs(failures: number): number {
  if (failures < THROTTLE_FREE_FAILURES) return 0;
  return Math.min(
    THROTTLE_FIRST_WAIT_MS * 2 ** (failures - THROTTLE_FREE_FAILURES),
    THROTTLE_MAX_WAIT_MS,
  );
}

/** Login throttle for each pair of email and IP, in memory (spec section 6.4). */
export class LoginThrottle {
  readonly #clock: Clock;
  readonly #entries = new Map<string, ThrottleEntry>();
  #calls = 0;

  constructor(options: { clock: Clock }) {
    this.#clock = options.clock;
  }

  /** Milliseconds that the key must still wait. 0 if an attempt is permitted now. */
  waitMs(key: string): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    return Math.max(0, entry.waitUntil - this.#clock.now());
  }

  /** Records a failure. Returns the wait that starts now. */
  fail(key: string): number {
    const now = this.#clock.now();
    this.#sweep(now);
    const entry = this.#entries.get(key) ?? { failures: 0, waitUntil: 0, lastFailureAt: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now;
    const wait = throttleWaitMs(entry.failures);
    entry.waitUntil = now + wait;
    this.#entries.set(key, entry);
    return wait;
  }

  /** A good login resets the pair. */
  reset(key: string): void {
    this.#entries.delete(key);
  }

  #sweep(now: number): void {
    this.#calls += 1;
    if (this.#calls % SWEEP_EVERY !== 0) return;
    for (const [key, entry] of this.#entries) {
      if (entry.waitUntil <= now && entry.lastFailureAt <= now - THROTTLE_MAX_WAIT_MS) {
        this.#entries.delete(key);
      }
    }
  }
}
