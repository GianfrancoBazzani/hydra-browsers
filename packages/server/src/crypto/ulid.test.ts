import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { newUlid, ulidTime } from './ulid.js';

describe('newUlid', () => {
  it('has 26 Crockford base32 characters', () => {
    expect(newUlid(new FakeClock())).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('encodes the clock time in the first 10 characters', () => {
    const id = newUlid(new FakeClock(1469918176385));
    expect(id.slice(0, 10)).toBe('01ARYZ6S41'); // example of the ULID specification
    expect(ulidTime(id)).toBe(1469918176385);
  });

  it('sorts by time', () => {
    const clock = new FakeClock(1_700_000_000_000);
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      ids.push(newUlid(clock));
      clock.advance(1);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it('gives different IDs in the same millisecond', () => {
    const clock = new FakeClock(1_700_000_000_000);
    expect(new Set(Array.from({ length: 1000 }, () => newUlid(clock))).size).toBe(1000);
  });

  it('rejects a time that does not fit in 48 bits', () => {
    expect(() => newUlid(new FakeClock(2 ** 48))).toThrow(RangeError);
    expect(() => newUlid(new FakeClock(-1))).toThrow(RangeError);
  });
});
