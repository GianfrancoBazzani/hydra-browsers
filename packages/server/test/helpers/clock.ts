import type { Clock } from '../../src/lib/clock.js';

/** A clock for tests. It moves only when the test calls advance() or set(). */
export class FakeClock implements Clock {
  #now: number;

  constructor(start: number = Date.UTC(2026, 9, 10, 12, 0, 0)) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  advance(ms: number): void {
    this.#now += ms;
  }

  set(ms: number): void {
    this.#now = ms;
  }
}
