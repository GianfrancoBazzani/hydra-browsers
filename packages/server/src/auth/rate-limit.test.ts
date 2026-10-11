import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { RateLimitedError, RateLimiter } from './rate-limit.js';

describe('RateLimiter', () => {
  it('permits `limit` takes in the window and rejects the next one', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000, clock });
    expect([limiter.take('ip'), limiter.take('ip'), limiter.take('ip')]).toEqual([
      true,
      true,
      true,
    ]);
    expect(limiter.take('ip')).toBe(false);
  });

  it('counts each key on its own', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000, clock });
    expect(limiter.take('a')).toBe(true);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('slides: a take expires exactly windowMs after it happened', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, clock });
    limiter.take('ip');
    clock.advance(30_000);
    limiter.take('ip');
    expect(limiter.take('ip')).toBe(false);
    clock.advance(29_999);
    expect(limiter.take('ip')).toBe(false);
    clock.advance(1);
    expect(limiter.take('ip')).toBe(true);
    expect(limiter.take('ip')).toBe(false);
  });

  it('does not count rejected takes', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 1, windowMs: 1_000, clock });
    limiter.take('ip');
    for (let i = 0; i < 5; i += 1) expect(limiter.take('ip')).toBe(false);
    clock.advance(1_000);
    expect(limiter.take('ip')).toBe(true);
  });

  it('reports the time until the next take can succeed', () => {
    const clock = new FakeClock(1_000_000);
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000, clock });
    expect(limiter.retryAfterMs('ip')).toBe(0);
    limiter.take('ip');
    clock.advance(10_000);
    limiter.take('ip');
    expect(limiter.retryAfterMs('ip')).toBe(50_000);
    clock.advance(50_000);
    expect(limiter.retryAfterMs('ip')).toBe(0);
  });
});

describe('RateLimitedError', () => {
  it('is a 429 rate_limited error with whole seconds, at least 1', () => {
    const error = new RateLimitedError(1_500);
    expect(error.code).toBe('rate_limited');
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(2);
    expect(new RateLimitedError(0).retryAfterSeconds).toBe(1);
  });
});
