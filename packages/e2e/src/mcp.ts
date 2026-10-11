import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { E2E } from './env.js';
import { parseEvaluateResult, toToolOutcome, type ToolOutcome } from './mcp-result.js';

export function mcpEndpoint(sid: string): string {
  return `${E2E.publicUrl}/s/${sid}/mcp`;
}

/** Connects an MCP client over Streamable HTTP with the agent token, as Claude Code does. */
export async function connectMcp(sid: string, secret: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpEndpoint(sid)), {
    requestInit: { headers: { Authorization: `Bearer ${secret}` } },
  });
  const client = new Client({ name: 'hydra-e2e', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  return toToolOutcome(await client.callTool({ name, arguments: args }));
}

/** Runs browser_evaluate with a function source and returns the parsed result. */
export async function evaluate(client: Client, fn: string): Promise<unknown> {
  const outcome = await callTool(client, 'browser_evaluate', { function: fn });
  if (outcome.isError) {
    throw new Error(`browser_evaluate failed: ${outcome.text}`);
  }
  return parseEvaluateResult(outcome.text);
}

/** Chromium can still load the error page of a blocked navigation when the next one starts. */
const INTERRUPTED = 'is interrupted by another navigation';

/** Navigates and fails on a tool error. Retries a navigation that the error page interrupted. */
export async function navigate(client: Client, url: string): Promise<ToolOutcome> {
  let outcome = await callTool(client, 'browser_navigate', { url });
  for (
    let retry = 0;
    retry < 3 && outcome.isError && outcome.text.includes(INTERRUPTED);
    retry += 1
  ) {
    await sleep(1_000);
    outcome = await callTool(client, 'browser_navigate', { url });
  }
  if (outcome.isError) {
    throw new Error(`browser_navigate ${url} failed: ${outcome.text}`);
  }
  return outcome;
}
