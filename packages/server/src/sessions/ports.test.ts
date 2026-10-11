import { describe, expect, it } from 'vitest';
import { lowestFreePort } from './ports.js';

describe('lowestFreePort', () => {
  const range = { first: 52000, last: 52003 };

  it('gives the first port of an empty pool', () => {
    expect(lowestFreePort(range, [])).toBe(52000);
  });

  it('gives the lowest gap', () => {
    expect(lowestFreePort(range, [52000, 52002])).toBe(52001);
    expect(lowestFreePort(range, [52001, 52000])).toBe(52002);
  });

  it('gives the last port', () => {
    expect(lowestFreePort(range, [52000, 52001, 52002])).toBe(52003);
  });

  it('gives null when all ports are in use', () => {
    expect(lowestFreePort(range, [52000, 52001, 52002, 52003])).toBeNull();
  });

  it('ignores ports outside the range', () => {
    expect(lowestFreePort(range, [51999, 52004])).toBe(52000);
  });
});
