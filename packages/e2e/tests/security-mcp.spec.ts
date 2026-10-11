import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '../src/fixtures.js';
import { initializeMessage, mcpPost, openGetStream, openRawSession } from '../src/mcp-raw.js';
import { mcpEndpoint } from '../src/mcp.js';

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
