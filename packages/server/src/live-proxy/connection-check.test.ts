import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../lib/logger.js';
import { startLiveConnectionCheck } from './connection-check.js';
import type { LiveService } from './live-service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('startLiveConnectionCheck', () => {
  it('runs the check every 60 s until stopped, and survives a failing check', () => {
    vi.useFakeTimers();
    const checkConnections = vi.fn(() => {
      if (checkConnections.mock.calls.length === 1) throw new Error('boom');
      return 0;
    });
    const live = { checkConnections } as unknown as LiveService;
    const stop = startLiveConnectionCheck({ live, logger: createLogger('fatal') });
    vi.advanceTimersByTime(59_999);
    expect(checkConnections).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(checkConnections).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(checkConnections).toHaveBeenCalledTimes(2);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(checkConnections).toHaveBeenCalledTimes(2);
  });
});
