import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, vaultCredentials } from '../../src/db/schema.js';
import {
  apiRequest,
  createAgentToken,
  listAudit,
  mcpPost,
  seedOwnerSession,
  startGateway,
  type Gateway,
  type SeededOwner,
} from '../helpers/mcp-gateway.js';

const PASSWORD = 'hunter2-"secret"';

interface FakePod {
  url: string;
  bodies: string[];
  reply: (body: string, req: IncomingMessage) => { type: 'json' | 'sse'; body: string };
  close(): Promise<void>;
}

async function startFakePod(): Promise<FakePod> {
  const pod: FakePod = {
    url: '',
    bodies: [],
    reply: (body) => {
      const id = (JSON.parse(body) as { id: number }).id;
      return {
        type: 'json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      };
    },
    close: () => Promise.resolve(),
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      pod.bodies.push(body);
      const { type, body: out } = pod.reply(body, req);
      res.writeHead(200, {
        'content-type': type === 'json' ? 'application/json' : 'text/event-stream',
        ...(type === 'json' ? { 'content-length': String(Buffer.byteLength(out)) } : {}),
      });
      res.end(type === 'json' ? out : `event: message\ndata: ${out}\n\n`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  pod.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  pod.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => {
        resolve();
      });
    });
  return pod;
}

let pod: FakePod;
let gw: Gateway;
let owner: SeededOwner;
let token: { id: string; secret: string };
let credentialId: string;

beforeEach(async () => {
  pod = await startFakePod();
  gw = await startGateway(pod.url);
  owner = await seedOwnerSession(gw);
  token = await createAgentToken(gw, owner.cookie, owner.sessionId);
  const res = await apiRequest(gw, owner.cookie, 'POST', `/api/sessions/${owner.sessionId}/vault`, {
    name: 'Example',
    website: 'https://www.example.com',
    username: 'agent@example.com',
    password: PASSWORD,
  });
  credentialId = (res.json() as { id: string }).id;
});

afterEach(async () => {
  await gw.close();
  await pod.close();
});

function fill(field: string, extra: Record<string, unknown> = {}, id: number = 3) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'vault_fill', arguments: { credentialId, field, target: 'e5', ...extra } },
  };
}

describe('vault tool calls through the gateway', () => {
  it('answers vault_list without the pod', async () => {
    const res = await mcpPost(gw, owner.sessionId, token.secret, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'vault_list', arguments: {} },
    });
    const body = await res.body.text();
    expect(body).toContain(
      `- ${credentialId} · Example · https://www.example.com · values: username, password`,
    );
    expect(body).not.toContain(PASSWORD);
    expect(pod.bodies).toEqual([]);
    const calls = await listAudit(gw, owner.cookie, owner.sessionId, 'mcp.tool_call');
    expect(calls.at(-1)).toMatchObject({ status: 'ok', data: { tool: 'vault_list' } });
  });

  it('sends hydraFill to the pod, never to the audit log, and removes the hydraFill of the agent', async () => {
    const res = await mcpPost(
      gw,
      owner.sessionId,
      token.secret,
      fill('password', { hydraFill: { value: 'from-agent' } }),
    );
    await res.body.text();
    expect(pod.bodies).toHaveLength(1);
    const sent = JSON.parse(pod.bodies[0] ?? '{}') as {
      params: { arguments: { hydraFill: unknown } };
    };
    expect(sent.params.arguments.hydraFill).toEqual({
      value: PASSWORD,
      scheme: 'https:',
      matchDomain: 'example.com',
      matchSubdomains: true,
    });
    const audit = JSON.stringify(gw.deps.db.select().from(auditEvents).all());
    expect(audit).not.toContain('hunter2');
    expect(audit).not.toContain('from-agent');
  });

  it('answers a deleted credential and rejects a batch with a vault call', async () => {
    gw.deps.db.delete(vaultCredentials).where(eq(vaultCredentials.id, credentialId)).run();
    const res = await mcpPost(gw, owner.sessionId, token.secret, fill('password'));
    expect(await res.body.text()).toContain(
      `Credential ${credentialId} does not exist in this session. Call vault_list.`,
    );
    const batch = await mcpPost(gw, owner.sessionId, token.secret, [fill('password', {}, 4)]);
    expect(await batch.body.text()).toContain(
      'Batch rejected, because it contains a vault tool call. Send vault tool calls one at a time.',
    );
    expect(pod.bodies).toEqual([]);
  });

  it('removes vault values from JSON and SSE responses and drops Content-Length', async () => {
    const escaped = JSON.stringify(PASSWORD).slice(1, -1);
    pod.reply = (body) => {
      const id = (JSON.parse(body) as { id: number }).id;
      const text = `- textbox "Password": "${escaped}" user agent@example.com`;
      return {
        type: id === 10 ? 'json' : 'sse',
        body: JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }),
      };
    };
    const snapshot = (id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'browser_snapshot', arguments: {} },
    });
    const json = await mcpPost(gw, owner.sessionId, token.secret, snapshot(10));
    expect(json.headers['content-length']).toBeUndefined();
    const jsonBody = await json.body.text();
    const sse = await (await mcpPost(gw, owner.sessionId, token.secret, snapshot(11))).body.text();
    for (const body of [jsonBody, sse]) {
      expect(body).not.toContain('hunter2');
      expect(body).not.toContain('agent@example.com');
      expect(body).toContain(`[vault:${credentialId}.password]`);
      expect(body).toContain(`[vault:${credentialId}.username]`);
    }
  });

  it('fails closed with 502 when the vault cannot be read', async () => {
    gw.deps.db
      .update(vaultCredentials)
      .set({ passwordEnc: Buffer.from('broken') })
      .where(eq(vaultCredentials.id, credentialId))
      .run();
    // A direct DB change does not drop the cache; a state event does, so the next request rebuilds the set.
    gw.deps.bus.publish({
      type: 'session.state',
      sessionId: owner.sessionId,
      state: 'stopped',
      previous: 'running',
      errorReason: null,
    });
    const res = await mcpPost(gw, owner.sessionId, token.secret, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
    });
    expect(res.statusCode).toBe(502);
    expect(await res.body.text()).toContain('The vault of the session cannot be read.');
  });
});
