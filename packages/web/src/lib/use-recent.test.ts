import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsRecent } from './use-recent';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useIsRecent', () => {
  it('is true for 10 s after the timestamp and then false', () => {
    const { result } = renderHook(() => useIsRecent(97_000, 10_000));
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1_100);
    });
    expect(result.current).toBe(false);
  });

  it('is false for null and for old timestamps', () => {
    expect(renderHook(() => useIsRecent(null, 10_000)).result.current).toBe(false);
    expect(renderHook(() => useIsRecent(50_000, 10_000)).result.current).toBe(false);
  });

  it('turns false for a timestamp that is already old when it arrives', () => {
    const { result, rerender } = renderHook(({ ts }) => useIsRecent(ts, 10_000), {
      initialProps: { ts: null as number | null },
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // 40 s old: for example the last tool call of another session that the view now shows.
    rerender({ ts: 120_000 });
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBe(false);
  });

  it('never renders true for an already old timestamp, not even before an effect runs', () => {
    const rendered: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ ts }) => {
        const recent = useIsRecent(ts, 10_000);
        rendered.push(recent);
        return recent;
      },
      { initialProps: { ts: null as number | null } },
    );
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    rendered.length = 0;
    rerender({ ts: Date.now() - 40_000 });
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain(true);
    expect(result.current).toBe(false);
  });

  it('is true at once for a fresh timestamp and turns false when the window ends', () => {
    const { result, rerender } = renderHook(({ ts }) => useIsRecent(ts, 10_000), {
      initialProps: { ts: null as number | null },
    });
    rerender({ ts: Date.now() });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(9_999);
    });
    expect(result.current).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current).toBe(false);
  });

  it('re-arms the timer when it fires while the clock still reads inside the window', () => {
    // A timer can fire a little early by Date.now(). The snapshot is still true then, and nothing
    // else subscribes again, so the hook must schedule a new timer for the rest of the window.
    const realNow = Date.now.bind(Date);
    let lag = 0;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => realNow() - lag);
    try {
      const { result } = renderHook(() => useIsRecent(97_000, 10_000));
      expect(result.current).toBe(true);
      lag = 5; // the clock is 5 ms behind the timers when the first one fires
      act(() => {
        vi.advanceTimersByTime(7_000);
      });
      // The first timer fired, but the clock reads 106 995: still inside the window.
      expect(result.current).toBe(true);
      act(() => {
        vi.advanceTimersByTime(5);
      });
      expect(result.current).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});
