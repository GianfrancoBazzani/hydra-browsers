import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../events/index.js';
import { createLogger } from '../lib/logger.js';
import {
  MCP_SHUTDOWN_GRACE_MS,
  runMcpConnectionCheck,
  scheduleMcpStreamShutdown,
  subscribeStreamClosers,
} from './closers.js';
import { StreamRegistry } from './stream-registry.js';

function setup(valid: Record<string, boolean>) {
  const bus = new EventBus(createLogger('fatal'));
  const mcpStreams = new StreamRegistry();
  const isValid = vi.fn((tokenId: string) => valid[tokenId] ?? false);
  const tokens = { isValid };
  const aborts: Record<string, string[]> = {};
  const open = (name: string, tokenId: string, userId: string, sessionId: string): void => {
    mcpStreams.register({
      tokenId,
      userId,
      sessionId,
      abort: (reason) => (aborts[name] ??= []).push(reason),
    });
  };
  const unsubscribe = subscribeStreamClosers({ bus, tokens, mcpStreams });
  return { bus, mcpStreams, tokens, isValid, aborts, open, unsubscribe };
}

describe('subscribeStreamClosers', () => {
  it('closes the streams of a revoked token', () => {
    const { bus, mcpStreams, aborts, open } = setup({});
    open('a', 't1', 'u1', 's1');
    open('b', 't2', 'u1', 's1');
    bus.publish({ type: 'token.revoked', tokenId: 't1', sessionId: 's1' });
    expect(aborts).toEqual({ a: ['token revoked'] });
    expect(mcpStreams.size()).toBe(1);
  });

  it('closes the streams of a session that leaves starting and running', () => {
    const { bus, aborts, open } = setup({});
    open('a', 't1', 'u1', 's1');
    open('b', 't2', 'u2', 's2');
    bus.publish({
      type: 'session.state',
      sessionId: 's1',
      state: 'starting',
      previous: 'running',
      errorReason: null,
    });
    bus.publish({
      type: 'session.state',
      sessionId: 's1',
      state: 'running',
      previous: 'starting',
      errorReason: null,
    });
    expect(aborts).toEqual({});
    bus.publish({
      type: 'session.state',
      sessionId: 's1',
      state: 'stopping',
      previous: 'running',
      errorReason: null,
    });
    expect(aborts).toEqual({ a: ['session stopping'] });
  });

  it('closes the streams of tokens whose creator lost token.create', () => {
    const { bus, aborts, open, isValid } = setup({ t1: false, t2: true, t3: false });
    open('a', 't1', 'u1', 's1');
    open('b', 't2', 'u1', 's2');
    open('c', 't3', 'u2', 's1');
    bus.publish({ type: 'rights.changed', userId: 'u1' });
    expect(aborts).toEqual({ a: ['rights changed'] });
    expect(isValid).not.toHaveBeenCalledWith('t3');
  });

  it('stops after unsubscribe', () => {
    const { bus, aborts, open, unsubscribe } = setup({});
    open('a', 't1', 'u1', 's1');
    unsubscribe();
    bus.publish({ type: 'token.revoked', tokenId: 't1', sessionId: 's1' });
    expect(aborts).toEqual({});
  });
});

describe('runMcpConnectionCheck', () => {
  it('closes the streams of tokens that are no longer valid and checks each token one time', () => {
    const { mcpStreams, tokens, isValid, aborts, open } = setup({ t1: true, t2: false });
    open('a', 't1', 'u1', 's1');
    open('b', 't2', 'u1', 's1');
    open('c', 't2', 'u1', 's1');
    expect(runMcpConnectionCheck({ tokens, mcpStreams })).toBe(2);
    expect(aborts).toEqual({ b: ['token no longer valid'], c: ['token no longer valid'] });
    expect(isValid).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleMcpStreamShutdown', () => {
  it('closes all MCP streams 10 s after the call', () => {
    vi.useFakeTimers();
    try {
      const { mcpStreams, aborts, open } = setup({});
      open('a', 't1', 'u1', 's1');
      open('b', 't2', 'u2', 's2');
      scheduleMcpStreamShutdown({ mcpStreams, logger: createLogger('fatal') });
      expect(MCP_SHUTDOWN_GRACE_MS).toBe(10_000);
      vi.advanceTimersByTime(9_999);
      expect(aborts).toEqual({});
      vi.advanceTimersByTime(1);
      expect(aborts).toEqual({ a: ['gateway shutting down'], b: ['gateway shutting down'] });
      expect(mcpStreams.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not close streams after the returned function was called', () => {
    vi.useFakeTimers();
    try {
      const { mcpStreams, aborts, open } = setup({});
      open('a', 't1', 'u1', 's1');
      const cancel = scheduleMcpStreamShutdown({ mcpStreams, logger: createLogger('fatal') });
      cancel();
      vi.advanceTimersByTime(MCP_SHUTDOWN_GRACE_MS);
      expect(aborts).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});
