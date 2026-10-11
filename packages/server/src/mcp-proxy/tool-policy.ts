// Tool deny list (spec section 8.7). Read from @playwright/mcp 0.0.83 (playwright-core 1.64.0-alpha-1790635538000).
//
// The list contains the tools that run code in the MCP server process instead of the page.
// - browser_run_code_unsafe: capability "core" (on by default). It runs the agent's code with node:vm in the
//   Playwright MCP process, with fetch, Buffer, and the Playwright page object ("RCE-equivalent" in its own
//   description). Its "filename" parameter also loads code from the file system of the MCP container.
// - browser_run_code: the name of the same tool before @playwright/mcp 0.0.78. It is kept, so that a version
//   change cannot enable it again without a review.
// browser_evaluate runs its code in the page (page.evaluate), so it is not in the list (spec section 8.6 keeps
// its code in the audit log).

import { jsonRpcError, type JsonRpcId } from './jsonrpc.js';

export const TOOL_DENY_LIST: ReadonlySet<string> = new Set([
  'browser_run_code_unsafe',
  'browser_run_code',
]);

/** JSON-RPC error code of a denied tool call (MCP uses -32602 for a call to an unknown tool). */
export const DENIED_TOOL_ERROR_CODE = -32602;

export function isToolDenied(tool: string): boolean {
  return TOOL_DENY_LIST.has(tool);
}

export function deniedToolMessage(tool: string): string {
  return `Tool ${tool} is blocked by the Hydra gateway, because it runs code in the MCP server process.`;
}

export const BATCH_REJECTED_MESSAGE =
  'Batch rejected, because it contains a tool call that the Hydra gateway blocks.';

export function deniedToolError(id: JsonRpcId | null, tool: string): Record<string, unknown> {
  return jsonRpcError(id, DENIED_TOOL_ERROR_CODE, deniedToolMessage(tool));
}
