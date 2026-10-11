import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { navigate } from './mcp.js';

const okText = '### Page\n- Page URL: http://site/\n- Page Title: Hydra test site';
const ok = { content: [{ type: 'text', text: okText }] };
const interrupted = {
  content: [
    {
      type: 'text',
      text: '### Error\nError: browserBackend.callTool: Navigation to "http://site/" is interrupted by another navigation to "chrome-error://chromewebdata/"',
    },
  ],
  isError: true,
};
const blocked = {
  content: [
    {
      type: 'text',
      text: '### Error\nError: browserBackend.callTool: net::ERR_BLOCKED_BY_ADMINISTRATOR at http://site/',
    },
  ],
  isError: true,
};

/** A client that answers browser_navigate with the given results, in order. */
function stubClient(results: unknown[]): { client: Client; urls: string[] } {
  const urls: string[] = [];
  const stub = {
    callTool: (params: { name: string; arguments?: Record<string, unknown> }) => {
      urls.push(String(params.arguments?.url));
      const next = results.shift();
      return next === undefined
        ? Promise.reject(new Error('no more results'))
        : Promise.resolve(next);
    },
  };
  return { client: stub as unknown as Client, urls };
}

describe('navigate', () => {
  it('retries a navigation that the error page of a blocked navigation interrupted', async () => {
    const { client, urls } = stubClient([interrupted, ok]);
    await expect(navigate(client, 'http://site/')).resolves.toEqual({
      isError: false,
      text: okText,
    });
    expect(urls).toEqual(['http://site/', 'http://site/']);
  });

  it('fails at once for another tool error', async () => {
    const { client, urls } = stubClient([blocked]);
    await expect(navigate(client, 'http://site/')).rejects.toThrow('ERR_BLOCKED_BY_ADMINISTRATOR');
    expect(urls).toEqual(['http://site/']);
  });

  it('gives up after three retries', async () => {
    const { client, urls } = stubClient([interrupted, interrupted, interrupted, interrupted]);
    await expect(navigate(client, 'http://site/')).rejects.toThrow(
      'is interrupted by another navigation',
    );
    expect(urls).toHaveLength(4);
  }, 10_000);
});
