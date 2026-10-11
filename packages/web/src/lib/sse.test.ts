import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { AuditPage, SessionResource } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryKeys } from '../api/keys';
import { makeAuditEvent, makeSession, SID, SID_2 } from '../test/fixtures';
import { MockEventSource } from '../test/mock-event-source';
import { createSessionEventStream, createUserEventStream, EventStream } from './sse';

let queryClient: QueryClient;

beforeEach(() => {
  MockEventSource.install();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  vi.useRealTimers();
});

function sessions() {
  return queryClient.getQueryData<SessionResource[]>(queryKeys.sessionList(false));
}

describe('createUserEventStream', () => {
  it('updates the state and the agent activity of a cached session', () => {
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession({ state: 'starting' })]);
    const stream = createUserEventStream(queryClient, { onReconnect: vi.fn() });
    stream.start();
    const source = MockEventSource.latest('/api/events');
    source.open();
    source.emit('session.state', { sessionId: SID, state: 'running', errorReason: null });
    source.emit('session.activity', {
      sessionId: SID,
      agentActivity: {
        activeAgentCount: 2,
        lastToolCall: { tool: 'browser_click', status: 'ok', durationMs: 230, startedAt: 1 },
      },
    });
    expect(sessions()?.[0]).toMatchObject({
      state: 'running',
      agentActivity: { activeAgentCount: 2 },
    });
    stream.stop();
  });

  it('removes a deleted session and fetches the lists for an unknown one', () => {
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    const stream = createUserEventStream(queryClient, { onReconnect: vi.fn() });
    stream.start();
    const source = MockEventSource.latest('/api/events');
    source.emit('session.state', { sessionId: SID_2, state: 'starting', errorReason: null });
    expect(queryClient.getQueryState(queryKeys.sessionList(false))?.isInvalidated).toBe(true);
    source.emit('session.state', { sessionId: SID, state: 'deleted', errorReason: null });
    expect(sessions()).toEqual([]);
    stream.stop();
  });

  it('ignores events that fail the schema', () => {
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    const stream = createUserEventStream(queryClient, { onReconnect: vi.fn() });
    stream.start();
    MockEventSource.latest('/api/events').emit('session.state', { sessionId: SID, state: 'odd' });
    expect(sessions()?.[0]?.state).toBe('running');
    stream.stop();
  });

  it('fetches the session data again after a reconnect (spec section 10.3)', () => {
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    queryClient.setQueryData(queryKeys.session(SID), makeSession());
    const onReconnect = vi.fn();
    const stream = createUserEventStream(queryClient, { onReconnect });
    stream.start();
    const source = MockEventSource.latest('/api/events');
    source.open();
    expect(onReconnect).not.toHaveBeenCalled();
    source.drop();
    source.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(queryClient.getQueryState(queryKeys.sessionList(false))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(queryKeys.session(SID))?.isInvalidated).toBe(true);
    stream.stop();
  });

  it('fetches all session data again when the gateway ends the stream (rights change)', () => {
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    queryClient.setQueryData(queryKeys.session(SID), makeSession());
    queryClient.setQueryData(queryKeys.tokens(SID), []);
    const onReconnect = vi.fn();
    const stream = createUserEventStream(queryClient, { onReconnect });
    stream.start();
    const source = MockEventSource.latest('/api/events');
    source.open();
    // Spec section 6.5: the gateway closes GET /api/events of the user. The browser reconnects.
    source.end();
    expect(MockEventSource.instances).toHaveLength(1);
    source.open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    const keys = [queryKeys.sessionList(false), queryKeys.session(SID), queryKeys.tokens(SID)];
    for (const key of keys) {
      expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    }
    stream.stop();
  });

  it('opens a new connection with a delay when the browser gave up, and checks the login', () => {
    vi.useFakeTimers();
    queryClient.setQueryData(queryKeys.me, null);
    const onReconnect = vi.fn();
    const stream = createUserEventStream(queryClient, { onReconnect });
    stream.start();
    MockEventSource.latest('/api/events').fail();
    expect(queryClient.getQueryState(queryKeys.me)?.isInvalidated).toBe(true);
    expect(MockEventSource.instances).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(MockEventSource.instances).toHaveLength(2);
    MockEventSource.latest('/api/events').open();
    expect(onReconnect).toHaveBeenCalledTimes(1);
    stream.stop();
  });
});

describe('EventStream', () => {
  it('connects at once on ensureOpen after the browser gave up', () => {
    vi.useFakeTimers();
    const stream = new EventStream({ url: '/api/events', handlers: {} });
    stream.start();
    MockEventSource.latest('/api/events').fail();
    stream.ensureOpen();
    expect(MockEventSource.instances).toHaveLength(2);
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(2);
    stream.stop();
  });

  it('does nothing after stop', () => {
    vi.useFakeTimers();
    const stream = new EventStream({ url: '/api/events', handlers: {} });
    stream.start();
    const source = MockEventSource.latest('/api/events');
    stream.stop();
    expect(source.readyState).toBe(MockEventSource.CLOSED);
    stream.ensureOpen();
    vi.advanceTimersByTime(60_000);
    expect(MockEventSource.instances).toHaveLength(1);
  });
});

describe('createSessionEventStream', () => {
  it('adds audit events to the Activity cache and fetches it again after a reconnect', () => {
    const data: InfiniteData<AuditPage, number | undefined> = {
      pages: [{ events: [makeAuditEvent({ id: 1 })], nextBefore: null }],
      pageParams: [undefined],
    };
    queryClient.setQueryData(queryKeys.audit(SID, {}), data);
    const stream = createSessionEventStream(queryClient, SID);
    stream.start();
    const source = MockEventSource.latest(`/api/sessions/${SID}/events`);
    source.open();
    source.emit('audit', makeAuditEvent({ id: 2 }));
    const cached = queryClient.getQueryData<InfiniteData<AuditPage>>(queryKeys.audit(SID, {}));
    expect(cached?.pages[0]?.events.map((e) => e.id)).toEqual([2, 1]);
    source.drop();
    source.open();
    expect(queryClient.getQueryState(queryKeys.audit(SID, {}))?.isInvalidated).toBe(true);
    stream.stop();
  });
});
