import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { systemClock } from './clock.js';

describe('clocks', () => {
  it('systemClock returns the current time in ms', () => {
    const before = Date.now();
    const now = systemClock.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it('FakeClock moves only with advance() and set()', () => {
    const clock = new FakeClock(1000);
    expect(clock.now()).toBe(1000);
    clock.advance(500);
    expect(clock.now()).toBe(1500);
    clock.set(42);
    expect(clock.now()).toBe(42);
    expect(new FakeClock().now()).toBe(Date.UTC(2026, 9, 10, 12, 0, 0));
  });
});
