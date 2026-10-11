// AppDeps.activity is the ActivityTracker, and the session resource shows its summary (spec 8.5).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityTracker, StreamRegistry } from '../../src/mcp-proxy/index.js';
import type { PodEndpointResolver } from '../../src/orchestrator/pod-endpoint.js';
import type { Reconciler } from '../../src/orchestrator/reconciler.js';
import { createTestApp } from '../helpers/app.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;

describe('MCP deps in createTestApp', () => {
  let t: TestApp | undefined;

  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  it('fills mcpStreams and activity', async () => {
    t = await createTestApp();
    expect(t.deps.mcpStreams).toBeInstanceOf(StreamRegistry);
    expect(t.deps.activity).toBeInstanceOf(ActivityTracker);
  });

  it('uses the reconciler and podEndpoints overrides in the deps and in SessionsService', async () => {
    const trigger = vi.fn();
    const reconciler = { trigger, stop: vi.fn(async () => {}) } as unknown as Reconciler;
    const podEndpoints = {
      resolve: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as PodEndpointResolver;
    t = await createTestApp({ reconciler, podEndpoints });
    const { app, deps } = t;
    expect(deps.reconciler).toBe(reconciler);
    expect(deps.podEndpoints).toBe(podEndpoints);

    const { password } = await seedUser(deps, { email: 'spy@example.com' });
    const cookie = await loginAs(app, 'spy@example.com', password);
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        host: deps.config.publicUrl.host,
        origin: deps.config.publicUrl.origin,
        'content-type': 'application/json',
        cookie,
      },
      payload: JSON.stringify({ name: 'Spy', allowlist: ['example.com'] }),
    });
    expect(res.statusCode).toBe(201);
    // SessionsService calls trigger(sid) on the overridden reconciler, not on one it built itself.
    expect(trigger).toHaveBeenCalledWith(res.json<{ id: string }>().id);
  });

  it('shows the activity of the audit events in GET /api/sessions/:sid, also the final status', async () => {
    t = await createTestApp();
    const { app, deps, clock } = t;
    const { user, password } = await seedUser(deps, { email: 'wiring@example.com' });
    const session = seedSession(deps, { ownerId: user.id, state: 'running' });
    const cookie = await loginAs(app, 'wiring@example.com', password);
    const get = async (): Promise<unknown> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/sessions/${session.id}`,
        headers: { host: deps.config.publicUrl.host, cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json<{ agentActivity: unknown }>().agentActivity;
    };

    expect(await get()).toEqual({ activeAgentCount: 0, lastToolCall: null });
    const startedAt = clock.now();
    deps.audit.write({
      kind: 'mcp.connect',
      actorType: 'token',
      actorId: 'tok-1',
      sessionId: session.id,
      data: { mcpSessionId: 'mcp-1', clientInfo: { name: 'c', version: '1' }, ip: '127.0.0.1' },
    });
    const call = deps.audit.write({
      kind: 'mcp.tool_call',
      actorType: 'token',
      actorId: 'tok-1',
      sessionId: session.id,
      status: 'pending',
      data: {
        mcpSessionId: 'mcp-1',
        rpcId: 1,
        tool: 'browser_click',
        arguments: {},
        durationMs: null,
        error: null,
      },
    });
    expect(await get()).toEqual({
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_click', status: 'pending', durationMs: null, startedAt },
    });

    // AuditWriter.update() publishes the updated event (plan 02); the tracker needs it.
    deps.audit.update(call.id, { status: 'ok', data: { ...call.data, durationMs: 42 } });
    expect(await get()).toEqual({
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_click', status: 'ok', durationMs: 42, startedAt },
    });
  });
});
