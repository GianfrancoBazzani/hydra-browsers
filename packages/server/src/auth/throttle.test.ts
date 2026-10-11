import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { LoginThrottle, throttleWaitMs } from './throttle.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

describe('throttleWaitMs', () => {
  it('waits 15 min after 5 failures and doubles each further failure, up to 24 h', () => {
    expect([1, 2, 3, 4].map(throttleWaitMs)).toEqual([0, 0, 0, 0]);
    expect(throttleWaitMs(5)).toBe(15 * MIN);
    expect(throttleWaitMs(6)).toBe(30 * MIN);
    expect(throttleWaitMs(7)).toBe(HOUR);
    expect(throttleWaitMs(8)).toBe(2 * HOUR);
    expect(throttleWaitMs(9)).toBe(4 * HOUR);
    expect(throttleWaitMs(10)).toBe(8 * HOUR);
    expect(throttleWaitMs(11)).toBe(16 * HOUR);
    expect(throttleWaitMs(12)).toBe(24 * HOUR);
    expect(throttleWaitMs(13)).toBe(24 * HOUR);
    expect(throttleWaitMs(5000)).toBe(24 * HOUR);
  });
});

describe('LoginThrottle', () => {
  it('permits 5 failures, then makes the pair wait', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 4; i += 1) {
      expect(throttle.fail('a@x.com|1.1.1.1')).toBe(0);
      expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(0);
    }
    expect(throttle.fail('a@x.com|1.1.1.1')).toBe(15 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(15 * MIN);
    clock.advance(10 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(5 * MIN);
    clock.advance(5 * MIN);
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(0);
    expect(throttle.fail('a@x.com|1.1.1.1')).toBe(30 * MIN);
  });

  it('keeps pairs apart, so another IP is not affected', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 5; i += 1) throttle.fail('a@x.com|1.1.1.1');
    expect(throttle.waitMs('a@x.com|1.1.1.1')).toBe(15 * MIN);
    expect(throttle.waitMs('a@x.com|2.2.2.2')).toBe(0);
  });

  it('resets the pair after a good login', () => {
    const clock = new FakeClock(1_000_000);
    const throttle = new LoginThrottle({ clock });
    for (let i = 0; i < 4; i += 1) throttle.fail('k');
    throttle.reset('k');
    expect(throttle.fail('k')).toBe(0);
  });
});
