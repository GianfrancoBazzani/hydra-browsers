import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '../lib/logger.js';
import { EventBus, type HydraEvent } from './bus.js';

function spyLogger(): Logger & { error: ReturnType<typeof vi.fn> } {
  return { error: vi.fn() } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
}

describe('EventBus', () => {
  it('delivers an event only to the handlers of its type, in subscription order', () => {
    const bus = new EventBus(spyLogger());
    const calls: string[] = [];
    bus.subscribe('rights.changed', (event) => calls.push(`a:${event.userId}`));
    bus.subscribe('rights.changed', (event) => calls.push(`b:${event.userId}`));
    bus.subscribe('token.revoked', (event) => calls.push(`token:${event.tokenId}`));
    bus.publish({ type: 'rights.changed', userId: 'u1' });
    expect(calls).toEqual(['a:u1', 'b:u1']);
  });

  it('publishes synchronously', () => {
    const bus = new EventBus(spyLogger());
    let received: HydraEvent | undefined;
    bus.subscribe('login.ended', (event) => {
      received = event;
    });
    bus.publish({ type: 'login.ended', userId: 'u1', loginSessionIds: ['l1'] });
    expect(received).toEqual({ type: 'login.ended', userId: 'u1', loginSessionIds: ['l1'] });
  });

  it('stops delivery after unsubscribe', () => {
    const bus = new EventBus(spyLogger());
    const handler = vi.fn();
    const unsubscribe = bus.subscribe('rights.changed', handler);
    unsubscribe();
    bus.publish({ type: 'rights.changed', userId: 'u1' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs a handler error and still calls the other handlers', () => {
    const logger = spyLogger();
    const bus = new EventBus(logger);
    const after = vi.fn();
    bus.subscribe('rights.changed', () => {
      throw new Error('boom');
    });
    bus.subscribe('rights.changed', after);
    expect(() => {
      bus.publish({ type: 'rights.changed', userId: 'u1' });
    }).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'rights.changed' }),
      'event handler failed',
    );
  });

  it('logs the rejection of an async handler and still calls the other handlers', async () => {
    const logger = spyLogger();
    const bus = new EventBus(logger);
    const failure = new Error('async boom');
    const after = vi.fn();
    bus.subscribe('rights.changed', () => Promise.reject(failure) as unknown as undefined);
    bus.subscribe('rights.changed', after);
    expect(() => {
      bus.publish({ type: 'rights.changed', userId: 'u1' });
    }).not.toThrow();
    expect(after).toHaveBeenCalledOnce();
    // The rejection is handled in a later tick, not in publish.
    expect(logger.error).not.toHaveBeenCalled();
    await new Promise<void>((done) => {
      setImmediate(done);
    });
    expect(logger.error).toHaveBeenCalledExactlyOnceWith(
      { err: failure, eventType: 'rights.changed' },
      'event handler failed',
    );
  });

  it('does not log an async handler that resolves', async () => {
    const logger = spyLogger();
    const bus = new EventBus(logger);
    bus.subscribe('rights.changed', () => Promise.resolve() as unknown as undefined);
    bus.publish({ type: 'rights.changed', userId: 'u1' });
    await new Promise<void>((done) => {
      setImmediate(done);
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('lets a handler unsubscribe itself during delivery', () => {
    const bus = new EventBus(spyLogger());
    const second = vi.fn();
    const unsubscribe = bus.subscribe('rights.changed', () => {
      unsubscribe();
    });
    bus.subscribe('rights.changed', second);
    bus.publish({ type: 'rights.changed', userId: 'u1' });
    bus.publish({ type: 'rights.changed', userId: 'u2' });
    expect(second).toHaveBeenCalledTimes(2);
  });
});
