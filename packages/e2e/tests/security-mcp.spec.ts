import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '../src/fixtures.js';
import { initializeMessage, mcpPost, openGetStream, openRawSession } from '../src/mcp-raw.js';
import { HydraApi } from '../src/api.js';
import { E2E } from '../src/env.js';
import { callTool, connectMcp, mcpEndpoint, navigate } from '../src/mcp.js';
import { STATE_FILES } from '../src/run-state.js';

test('a token for session A gets 401 on session B', async ({ adminApi, sessionPair }) => {
  const { a, b } = sessionPair;
  const token = await adminApi.createToken(a.id, 'e2e-token-a');
  try {
    // Control: the token works on its own session.
    expect((await mcpPost(mcpEndpoint(a.id), token.secret, initializeMessage())).status).toBe(200);
    const other = await mcpPost(mcpEndpoint(b.id), token.secret, initializeMessage());
    expect(other.status).toBe(401);
    expect(other.headers['www-authenticate']).toBe('Bearer realm="hydra"');
  } finally {
    await adminApi.revokeToken(a.id, token.token.id);
  }
});

test('a revoked token gets 401, and its open MCP stream closes', async ({
  adminApi,
  sessionPair,
}) => {
  const { a } = sessionPair;
  const token = await adminApi.createToken(a.id, 'e2e-revoke');
  const session = await openRawSession(mcpEndpoint(a.id), token.secret);
  const stream = await openGetStream(session);
  try {
    expect(stream.status).toBe(200);
    await sleep(2_000);
    expect(stream.isOpen()).toBe(true);

    const revokedAt = Date.now();
    await adminApi.revokeToken(a.id, token.token.id);
    // The gateway closes the MCP streams of a revoked token at once (spec section 8.3).
    await Promise.race([stream.closed, sleep(5_000)]);
    expect(stream.isOpen(), 'the MCP stream closed within 5 s after the revoke').toBe(false);
    test.info().annotations.push({
      type: 'stream closed after',
      description: `${Date.now() - revokedAt} ms`,
    });

    const after = await mcpPost(
      mcpEndpoint(a.id),
      token.secret,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    );
    expect(after.status).toBe(401);
    expect(after.headers['www-authenticate']).toBe('Bearer realm="hydra"');
  } finally {
    stream.close();
  }
});

test('a credential of another site cannot fill the test site, and only the owner reveals', async ({
  adminApi,
  sessionPair,
  run,
}) => {
  const { a } = sessionPair;
  const { id } = await adminApi.createCredential(a.id, {
    name: 'Other',
    website: 'https://example.com',
    password: 'Other-Password-1',
  });
  const token = await adminApi.createToken(a.id, 'e2e-vault');
  const client = await connectMcp(a.id, token.secret);
  const memberApi = await HydraApi.create(STATE_FILES.viewer);
  try {
    // Spec section 6.9.2: the fill works only on the site of the credential.
    await navigate(client, `${E2E.testsite.origin}${E2E.testsite.loginPath}`);
    const snapshot = (await callTool(client, 'browser_snapshot', {})).text;
    const target = /textbox "Password"[^\n]*\[ref=([a-z0-9]+)\]/.exec(snapshot)?.[1] ?? '';
    const result = await callTool(client, 'vault_fill', {
      credentialId: id,
      field: 'password',
      target,
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('fills only on example.com and its subdomains');
    expect(result.text).not.toContain('Other-Password-1');

    // Spec section 6.9.5: an operator and a viewer get 403 on the reveal route.
    const member = run.viewer;
    const added = await adminApi.call('POST', `/api/sessions/${a.id}/members`, {
      email: member.email,
      role: 'operator',
    });
    expect(added.status).toBeLessThan(300);
    expect(await memberApi.revealCredential(a.id, id, 'password')).toBe(403);
    await adminApi.call('PATCH', `/api/sessions/${a.id}/members/${member.id}`, { role: 'viewer' });
    expect(await memberApi.revealCredential(a.id, id, 'password')).toBe(403);
  } finally {
    await client.close();
    await memberApi.dispose();
    await adminApi.removeMember(a.id, run.viewer.id).catch(() => undefined);
    await adminApi.revokeToken(a.id, token.token.id);
  }
});
