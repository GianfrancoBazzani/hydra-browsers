// Sharing rules around the MCP proxy (spec sections 6.5, 8.3, 8.5, 15.2) against a real Playwright MCP.
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SessionActivityEventSchema, type AgentActivity } from '@hydra/shared';
import { request } from 'undici';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loginAs, seedUser } from '../helpers/seed.js';
import {
  apiRequest,
  createAgentToken,
  eventually,
  mcpClient,
  mcpPost,
  readSseUntil,
  seedOwnerSession,
  startGateway,
  type Gateway,
  type SeededOwner,
} from '../helpers/mcp-gateway.js';
import { startMcpSidecar, type PlaywrightMcp } from '../helpers/playwright-mcp.js';

const PAGE = 'data:text/html,<title>Hydra access test</title><p>Hello</p>';

describe('MCP proxy and session sharing', { timeout: 60_000 }, () => {
  let pw: PlaywrightMcp;
  let gw: Gateway;
  let owner: SeededOwner;
  const clients: Client[] = [];

  async function addMember(email: string, role: 'operator' | 'viewer') {
    const member = await seedUser(gw.deps, { email });
    const res = await apiRequest(
      gw,
      owner.cookie,
      'POST',
      `/api/sessions/${owner.sessionId}/members`,
      {
        email,
        role,
      },
    );
    expect(res.statusCode).toBeLessThan(300);
    const cookie = await loginAs(gw.app, email, member.password);
    return { userId: member.user.id, cookie };
  }

  async function connectAgent(secret: string) {
    const agent = mcpClient(gw, owner.sessionId, secret);
    clients.push(agent.client);
    await agent.client.connect(agent.transport);
    return agent;
  }

  beforeAll(async () => {
    pw = await startMcpSidecar();
  }, 600_000);

  afterAll(async () => {
    await pw.stop();
  });

  beforeEach(async () => {
    gw = await startGateway(pw.url);
    owner = await seedOwnerSession(gw);
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => undefined);
    await gw.close();
  });

  it('closes the MCP streams of the tokens of a removed member at once, and keeps the others', async () => {
    const member = await addMember('member@example.com', 'operator');
    const memberToken = await createAgentToken(gw, member.cookie, owner.sessionId);
    const ownerToken = await createAgentToken(gw, owner.cookie, owner.sessionId);
    const memberAgent = await connectAgent(memberToken.secret);
    const ownerAgent = await connectAgent(ownerToken.secret);
    await eventually(() => {
      expect(gw.deps.mcpStreams.size()).toBe(2); // the GET stream of each agent
    });

    const removed = await apiRequest(
      gw,
      owner.cookie,
      'DELETE',
      `/api/sessions/${owner.sessionId}/members/${member.userId}`,
      {},
    );
    expect(removed.statusCode).toBeLessThan(300);

    expect(gw.deps.mcpStreams.size()).toBe(1);
    await expect(memberAgent.client.listTools()).rejects.toThrow();
    const { tools } = await ownerAgent.client.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const after = await mcpPost(gw, owner.sessionId, memberToken.secret, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    });
    expect(after.statusCode).toBe(401);
    await after.body.text();
  });

  it('gives a viewer the agent activity without arguments, but 403 on the audit log', async () => {
    const viewer = await addMember('viewer@example.com', 'viewer');
    const token = await createAgentToken(gw, owner.cookie, owner.sessionId);
    const { client } = await connectAgent(token.secret);
    await client.callTool({ name: 'browser_navigate', arguments: { url: PAGE } });

    const res = await apiRequest(gw, viewer.cookie, 'GET', `/api/sessions/${owner.sessionId}`);
    expect(res.statusCode).toBe(200);
    const resource = res.json<{ myRole: string; agentActivity: unknown }>();
    expect(resource.myRole).toBe('viewer');
    expect(resource.agentActivity).toEqual({
      activeAgentCount: 1,
      lastToolCall: {
        tool: 'browser_navigate',
        status: 'ok',
        durationMs: expect.any(Number) as unknown,
        startedAt: expect.any(Number) as unknown,
      },
    });

    const audit = await apiRequest(
      gw,
      viewer.cookie,
      'GET',
      `/api/sessions/${owner.sessionId}/audit`,
    );
    expect(audit.statusCode).toBe(403);
    expect(audit.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('sends session.activity to a viewer on GET /api/events after a tool call', async () => {
    const viewer = await addMember('viewer2@example.com', 'viewer');
    const token = await createAgentToken(gw, owner.cookie, owner.sessionId);
    const controller = new AbortController();
    try {
      const events = request(gw.url('/api/events'), {
        dispatcher: gw.dispatcher,
        headers: { cookie: viewer.cookie, accept: 'text/event-stream' },
        signal: controller.signal,
      });
      events.catch(() => undefined); // the finally block aborts the request
      await new Promise((resolve) => setTimeout(resolve, 200)); // the SSE route subscribes to the bus
      const { client } = await connectAgent(token.secret);
      await client.callTool({ name: 'browser_navigate', arguments: { url: PAGE } });
      const res = await events;
      res.body.on('error', () => undefined); // abort() in the finally block destroys the body
      expect(res.statusCode).toBe(200);
      const event = await readSseUntil(res.body, (candidate) => {
        if (candidate.event !== 'session.activity') return false;
        const data = SessionActivityEventSchema.parse(JSON.parse(candidate.data));
        return (
          data.sessionId === owner.sessionId &&
          data.agentActivity.lastToolCall?.tool === 'browser_navigate' &&
          data.agentActivity.lastToolCall.status === 'ok'
        );
      });
      const data = SessionActivityEventSchema.parse(JSON.parse(event.data));
      expect(data.agentActivity.activeAgentCount).toBe(1);
    } finally {
      controller.abort();
    }
  });

  it('does not count an MCP session that the pod no longer knows (404), after the agent initializes again', async () => {
    const token = await createAgentToken(gw, owner.cookie, owner.sessionId);
    // A restart of the session ended the MCP session of the agent: the pod answers 404.
    const stale = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'browser_tabs', arguments: { action: 'list' } },
      },
      { 'mcp-session-id': 'ended-mcp-session' },
    );
    expect(stale.statusCode).toBe(404);
    await stale.body.text();
    await connectAgent(token.secret);

    const res = await apiRequest(gw, owner.cookie, 'GET', `/api/sessions/${owner.sessionId}`);
    expect(res.json<{ agentActivity: AgentActivity }>().agentActivity.activeAgentCount).toBe(1);
  });

  it('counts two agents, and the count goes down 60 s after their last activity', async () => {
    const first = await createAgentToken(gw, owner.cookie, owner.sessionId);
    const second = await createAgentToken(gw, owner.cookie, owner.sessionId);
    await connectAgent(first.secret);
    await connectAgent(second.secret);
    const res = await apiRequest(gw, owner.cookie, 'GET', `/api/sessions/${owner.sessionId}`);
    expect(res.json<{ agentActivity: AgentActivity }>().agentActivity.activeAgentCount).toBe(2);

    const published: AgentActivity[] = [];
    gw.deps.bus.subscribe('session.activity', (event) => {
      if (event.sessionId === owner.sessionId) published.push(event.agentActivity);
    });
    gw.clock.advance(60_000);
    gw.deps.activity.sweep();
    expect(published).toEqual([{ activeAgentCount: 0, lastToolCall: null }]);
    const later = await apiRequest(gw, owner.cookie, 'GET', `/api/sessions/${owner.sessionId}`);
    expect(later.json<{ agentActivity: AgentActivity }>().agentActivity.activeAgentCount).toBe(0);
  });
});
