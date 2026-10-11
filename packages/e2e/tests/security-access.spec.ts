import { isIP } from 'node:net';
import type { Method } from '../src/api.js';
import { errorCode } from '../src/api.js';
import { auditIps, dockerNetworkSubnets, nodeInternalIp } from '../src/cluster.js';
import { E2E } from '../src/env.js';
import { expect, test } from '../src/fixtures.js';
import { openRawSession } from '../src/mcp-raw.js';
import { mcpEndpoint } from '../src/mcp.js';
import { ipInCidr, normalizeIp } from '../src/net.js';

test('a user without access gets 404 for the session', async ({
  adminApi,
  outsiderApi,
  sessionPair,
}) => {
  const sid = sessionPair.a.id;
  // A valid session ID (12 characters a-z2-7) that does not exist.
  const missing = 'zzzzzzzzzzzz';
  const requests: Array<{ method: Method; path: string; data?: unknown }> = [
    { method: 'GET', path: `/api/sessions/${sid}` },
    { method: 'PATCH', path: `/api/sessions/${sid}`, data: { name: 'e2e-taken' } },
    { method: 'POST', path: `/api/sessions/${sid}/start` },
    { method: 'POST', path: `/api/sessions/${sid}/stop` },
    { method: 'POST', path: `/api/sessions/${sid}/restart` },
    {
      method: 'POST',
      path: `/api/sessions/${sid}/delete`,
      data: { confirmName: sessionPair.a.name },
    },
    { method: 'GET', path: `/api/sessions/${sid}/logs?container=neko` },
    { method: 'POST', path: `/api/sessions/${sid}/live-ticket` },
    { method: 'GET', path: `/api/sessions/${sid}/events` },
    { method: 'GET', path: `/api/sessions/${sid}/members` },
    {
      method: 'POST',
      path: `/api/sessions/${sid}/members`,
      data: { email: 'nobody@hydra.test', role: 'viewer' },
    },
    { method: 'GET', path: `/api/sessions/${sid}/tokens` },
    {
      method: 'POST',
      path: `/api/sessions/${sid}/tokens`,
      data: { name: 'e2e-taken', expiresInDays: 1 },
    },
    { method: 'GET', path: `/api/sessions/${sid}/audit` },
  ];

  // Control: the owner can read the session.
  expect((await adminApi.call('GET', `/api/sessions/${sid}`)).status).toBe(200);
  for (const { method, path, data } of requests) {
    const label = `${method} ${path}`;
    const result = await outsiderApi.call(method, path, data, { timeoutMs: 10_000 });
    expect.soft(result.status, label).toBe(404);
    expect.soft(errorCode(result.json), label).toBe('not_found');
    const other = await outsiderApi.call(method, path.replace(sid, missing), data, {
      timeoutMs: 10_000,
    });
    expect
      .soft(
        other.text.replaceAll(missing, '<sid>'),
        `${label}: same body as for a session that does not exist`,
      )
      .toBe(result.text.replaceAll(sid, '<sid>'));
  }
  expect((await outsiderApi.listSessions(false)).map((session) => session.id)).not.toContain(sid);
  // The delete request above did nothing.
  expect((await adminApi.getSession(sid)).state).toBe('running');
});

test('the ip of the auth.login audit event is the client address, not a pod address', async ({
  adminApi,
  run,
  sessionPair,
}) => {
  const node = await nodeInternalIp();
  const subnets = await dockerNetworkSubnets();
  const expectClientAddress = (label: string, raw: string): void => {
    const ip = normalizeIp(raw);
    expect.soft(isIP(ip), `${label}: "${raw}" is an IP address`).not.toBe(0);
    expect.soft(ipInCidr(ip, E2E.podCidr), `${label}: ${ip} is not a pod address`).toBe(false);
    expect
      .soft(ipInCidr(ip, E2E.serviceCidr), `${label}: ${ip} is not a Service address`)
      .toBe(false);
    expect.soft(ip, `${label}: ${ip} is not the node address`).not.toBe(node);
    if (E2E.expectedClientIp !== undefined) {
      expect.soft(ip, label).toBe(E2E.expectedClientIp);
    } else {
      // Traffic from the host reaches the node from the k3d Docker network (load balancer or bridge).
      const inNetwork = subnets.some((subnet) => ipInCidr(ip, subnet));
      expect
        .soft(inNetwork, `${label}: ${ip} is in the k3d Docker network ${subnets.join(', ')}`)
        .toBe(true);
    }
  };

  const logins = await auditIps('auth.login', run.admin.id);
  expect(logins.length).toBeGreaterThan(0);
  for (const ip of logins) {
    expectClientAddress('auth.login', ip);
  }

  // The MCP path records the client address too (mcp.connect, spec section 8.6).
  const token = await adminApi.createToken(sessionPair.a.id, 'e2e-ip');
  try {
    const raw = await openRawSession(mcpEndpoint(sessionPair.a.id), token.secret);
    const connects = await adminApi.audit(sessionPair.a.id, { kind: 'mcp.connect', limit: 200 });
    const event = connects.events.find((entry) => entry.data.mcpSessionId === raw.id);
    expect(event, 'the mcp.connect event of this MCP session').toBeDefined();
    expectClientAddress('mcp.connect', String(event?.data.ip));
  } finally {
    await adminApi.revokeToken(sessionPair.a.id, token.token.id);
  }
});
