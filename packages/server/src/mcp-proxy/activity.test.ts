import { afterEach, describe, expect, it } from 'vitest';
import type { AgentActivity, AuditEvent } from '@hydra/shared';
import { FakeClock } from '../../test/helpers/clock.js';
import { EventBus } from '../events/index.js';
import { createLogger } from '../lib/logger.js';
import { ACTIVITY_WINDOW_MS, ActivityTracker } from './activity.js';

const trackers: ActivityTracker[] = [];
afterEach(() => {
  for (const tracker of trackers.splice(0)) tracker.stop();
});

function setup() {
  const clock = new FakeClock(1_000_000);
  const bus = new EventBus(createLogger('fatal'));
  const tracker = new ActivityTracker({ bus, clock });
  tracker.start();
  trackers.push(tracker);
  const published: { sessionId: string; agentActivity: AgentActivity }[] = [];
  bus.subscribe('session.activity', (event) => {
    published.push({ sessionId: event.sessionId, agentActivity: event.agentActivity });
  });
  let nextId = 1;
  // The AuditWriter publishes { type: 'audit' } for write() and for update() (index section 5.7).
  const emit = (event: Omit<AuditEvent, 'actorType' | 'actorId' | 'actorName'>): AuditEvent => {
    const full: AuditEvent = { ...event, actorType: 'token', actorId: 'tok', actorName: null };
    bus.publish({ type: 'audit', event: full });
    return full;
  };
  const connect = (sessionId: string, mcpSessionId: string): AuditEvent =>
    emit({
      id: nextId++,
      ts: clock.now(),
      kind: 'mcp.connect',
      sessionId,
      status: null,
      data: { mcpSessionId, clientInfo: { name: 'c', version: '1' }, ip: '127.0.0.1' },
    });
  const toolCall = (sessionId: string, mcpSessionId: string, tool: string): AuditEvent =>
    emit({
      id: nextId++,
      ts: clock.now(),
      kind: 'mcp.tool_call',
      sessionId,
      status: 'pending',
      data: {
        mcpSessionId,
        rpcId: 1,
        tool,
        arguments: { url: 'x' },
        durationMs: null,
        error: null,
      },
    });
  const finish = (call: AuditEvent, status: 'ok' | 'error', durationMs: number): AuditEvent =>
    emit({ ...call, status, data: { ...call.data, durationMs } });
  return { clock, bus, tracker, published, emit, connect, toolCall, finish };
}

describe('ActivityTracker', () => {
  it('returns an empty summary for a session without MCP events', () => {
    const { tracker } = setup();
    expect(tracker.get('s1')).toEqual({ activeAgentCount: 0, lastToolCall: null });
  });

  it('counts MCP sessions with an mcp.* event in the last 60 s', () => {
    const { tracker, connect, clock } = setup();
    connect('s1', 'm1');
    connect('s1', 'm2');
    connect('s1', 'm2');
    connect('s2', 'm3');
    expect(tracker.get('s1').activeAgentCount).toBe(2);
    expect(tracker.get('s2').activeAgentCount).toBe(1);
    clock.advance(ACTIVITY_WINDOW_MS - 1);
    expect(tracker.get('s1').activeAgentCount).toBe(2);
    clock.advance(1);
    expect(tracker.get('s1').activeAgentCount).toBe(0);
  });

  it('keeps the newest tool call without arguments, and updates its status', () => {
    const { tracker, toolCall, finish, clock } = setup();
    const startedAt = clock.now();
    const call = toolCall('s1', 'm1', 'browser_click');
    expect(tracker.get('s1').lastToolCall).toEqual({
      tool: 'browser_click',
      status: 'pending',
      durationMs: null,
      startedAt,
    });
    clock.advance(230);
    finish(call, 'ok', 230);
    expect(tracker.get('s1')).toEqual({
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_click', status: 'ok', durationMs: 230, startedAt },
    });
  });

  it('does not replace a newer call with the result of an older call', () => {
    const { tracker, toolCall, finish, clock } = setup();
    const older = toolCall('s1', 'm1', 'browser_wait_for');
    clock.advance(10);
    toolCall('s1', 'm1', 'browser_snapshot');
    finish(older, 'ok', 2000);
    expect(tracker.get('s1').lastToolCall?.tool).toBe('browser_snapshot');
    expect(tracker.get('s1').lastToolCall?.status).toBe('pending');
  });

  it('publishes session.activity when the summary changes, and not otherwise', () => {
    const { published, connect, toolCall } = setup();
    connect('s1', 'm1');
    connect('s1', 'm1');
    expect(published).toEqual([
      { sessionId: 's1', agentActivity: { activeAgentCount: 1, lastToolCall: null } },
    ]);
    toolCall('s1', 'm1', 'browser_navigate');
    expect(published).toHaveLength(2);
    expect(published[1]?.agentActivity.lastToolCall?.tool).toBe('browser_navigate');
  });

  it('publishes from the timer when the count goes down', () => {
    const { tracker, published, connect, clock } = setup();
    connect('s1', 'm1');
    clock.advance(30_000);
    connect('s1', 'm2');
    published.length = 0;
    clock.advance(30_000);
    tracker.sweep();
    expect(published).toEqual([
      { sessionId: 's1', agentActivity: { activeAgentCount: 1, lastToolCall: null } },
    ]);
    clock.advance(30_000);
    tracker.sweep();
    expect(published).toEqual([
      { sessionId: 's1', agentActivity: { activeAgentCount: 1, lastToolCall: null } },
      { sessionId: 's1', agentActivity: { activeAgentCount: 0, lastToolCall: null } },
    ]);
    tracker.sweep();
    expect(published).toHaveLength(2);
  });

  it('removes a finished tool call 60 s after it finished, and keeps a pending call', () => {
    const { tracker, toolCall, finish, clock } = setup();
    finish(toolCall('s1', 'm1', 'browser_click'), 'error', 5);
    clock.advance(ACTIVITY_WINDOW_MS);
    tracker.sweep();
    expect(tracker.get('s1')).toEqual({ activeAgentCount: 0, lastToolCall: null });
    toolCall('s2', 'm2', 'browser_wait_for');
    clock.advance(10 * ACTIVITY_WINDOW_MS);
    tracker.sweep();
    expect(tracker.get('s2').lastToolCall?.status).toBe('pending');
  });

  it('stops to count an MCP session that the MCP server ended, and keeps the last tool call', () => {
    const { tracker, published, connect, toolCall, finish } = setup();
    connect('s1', 'm1');
    finish(toolCall('s1', 'm2', 'browser_tabs'), 'error', 3);
    expect(tracker.get('s1').activeAgentCount).toBe(2);
    published.length = 0;
    tracker.endMcpSession('s1', 'm2');
    expect(tracker.get('s1')).toEqual({
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_tabs', status: 'error', durationMs: 3, startedAt: 1_000_000 },
    });
    expect(published).toHaveLength(1);
    expect(published[0]?.agentActivity.activeAgentCount).toBe(1);
    tracker.endMcpSession('s1', 'unknown');
    tracker.endMcpSession('s9', 'm1');
    expect(published).toHaveLength(1);
  });

  it('ignores audit events of other kinds and stops after stop()', () => {
    const { tracker, emit, connect, clock } = setup();
    emit({
      id: 99,
      ts: clock.now(),
      kind: 'auth.login',
      sessionId: 's1',
      status: null,
      data: { mcpSessionId: 'm9' },
    });
    expect(tracker.get('s1').activeAgentCount).toBe(0);
    tracker.stop();
    connect('s1', 'm1');
    expect(tracker.get('s1').activeAgentCount).toBe(0);
  });
});
