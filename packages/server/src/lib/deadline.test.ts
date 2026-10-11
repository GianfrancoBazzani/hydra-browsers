import { afterEach, describe, expect, it, vi } from 'vitest';
import { withDeadline } from './deadline.js';
import { createLogger } from './logger.js';

describe('withDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves when the promise settles in time, with no warning', async () => {
    vi.useFakeTimers();
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn');
    await withDeadline(Promise.resolve(), 1_000, 'the step', logger);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('logs a warning and continues when the promise does not settle by the deadline', async () => {
    vi.useFakeTimers();
    const logger = createLogger('fatal');
    const warn = vi.spyOn(logger, 'warn');
    const never = new Promise<void>(() => undefined);
    const done = vi.fn();
    const run = withDeadline(never, 5_000, 'stopping the reconciler', logger).then(done);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await run;
    expect(done).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      { label: 'stopping the reconciler', deadlineMs: 5_000 },
      'stopping the reconciler did not finish in time, continuing',
    );
  });

  it('passes the rejection of the promise on', async () => {
    vi.useFakeTimers();
    await expect(
      withDeadline(Promise.reject(new Error('boom')), 1_000, 'the step', createLogger('fatal')),
    ).rejects.toThrow('boom');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores a rejection that arrives after the deadline', async () => {
    vi.useFakeTimers();
    const late = Promise.withResolvers<void>();
    const run = withDeadline(late.promise, 100, 'the step', createLogger('fatal'));
    await vi.advanceTimersByTimeAsync(100);
    await run;
    late.reject(new Error('too late'));
    await vi.advanceTimersByTimeAsync(0);
  });
});
