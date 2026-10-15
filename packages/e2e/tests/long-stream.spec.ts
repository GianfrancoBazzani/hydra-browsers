import { setTimeout as sleep } from 'node:timers/promises';
import { expect, test } from '../src/fixtures.js';
import { mcpPost, openGetStream, openRawSession } from '../src/mcp-raw.js';
import { mcpEndpoint } from '../src/mcp.js';

const TEN_MINUTES = 10 * 60_000;

// Runs only on pull requests that change deploy/traefik/ or scripts/versions.sh (spec section
// 15.3), or manually with `pnpm --filter @hydra/e2e run test:long`. The stream carries no data, so
// any idle timeout on the path (Traefik entry point, gateway, undici) would close it.
test(
  'an MCP stream stays open for 10 min through Traefik',
  { tag: '@long' },
  async ({ adminApi, sessionPair }) => {
    test.setTimeout(15 * 60_000);
    const { a } = sessionPair;
    const token = await adminApi.createToken(a.id, 'e2e-long-stream');
    const session = await openRawSession(mcpEndpoint(a.id), token.secret);
    const stream = await openGetStream(session);
    try {
      expect(stream.status).toBe(200);
      const openedAt = Date.now();
      while (Date.now() - openedAt < TEN_MINUTES) {
        await Promise.race([stream.closed, sleep(30_000)]);
        const seconds = Math.round((Date.now() - openedAt) / 1_000);
        expect(stream.isOpen(), `the MCP stream is open after ${seconds} s`).toBe(true);
      }
      // The MCP session still answers after the 10 min.
      const list = await mcpPost(
        session.endpoint,
        session.token,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        session,
      );
      expect(list.status).toBe(200);
      expect(stream.isOpen()).toBe(true);
    } finally {
      stream.close();
      await adminApi.revokeToken(a.id, token.token.id);
    }
  },
);
