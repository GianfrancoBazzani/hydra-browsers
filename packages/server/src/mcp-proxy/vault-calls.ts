// The vault tool calls of the gateway (spec section 8.8.2).
import { z } from 'zod';
import { VAULT_TOOL_NAMES, VaultFillArgumentsSchema, type HydraFill } from '@hydra/shared';
import { VaultDecryptError, type VaultService } from '../vault/index.js';
import {
  isObject,
  jsonRpcErrorBody,
  toolCallArguments,
  toolCallName,
  type JsonRpcMessage,
  type RequestMessage,
} from './jsonrpc.js';

export const VAULT_UNREADABLE_BODY = jsonRpcErrorBody(
  null,
  -32000,
  'The vault of the session cannot be read.',
);

export type VaultCallOutcome =
  { kind: 'answer'; body: string } | { kind: 'forward'; body: Buffer; waitMs: number };

const VAULT_TOOLS: ReadonlySet<string> = new Set(VAULT_TOOL_NAMES);

export function isVaultCall(message: JsonRpcMessage): boolean {
  const tool = toolCallName(message);
  return tool !== null && VAULT_TOOLS.has(tool);
}

/** Step 1: only the gateway sets hydraFill. */
export function withoutHydraFill(message: RequestMessage): RequestMessage {
  if (!isObject(message.params)) return message;
  const args = message.params.arguments;
  if (!isObject(args) || !Object.hasOwn(args, 'hydraFill')) return message;
  const rest: Record<string, unknown> = { ...args };
  delete rest.hydraFill;
  return { ...message, params: { ...message.params, arguments: rest } };
}

function answer(id: RequestMessage['id'], text: string, isError = false): VaultCallOutcome {
  const result = { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
  return { kind: 'answer', body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

/** Steps 2 to 5 for one request without a batch. `message` is the call without the hydraFill of the agent. */
export function planVaultCall(
  vault: Pick<VaultService, 'agentList' | 'fillValue'>,
  sessionId: string,
  message: RequestMessage,
  logError: (err: VaultDecryptError) => void = () => undefined,
): VaultCallOutcome {
  if (toolCallName(message) === 'vault_list') return answer(message.id, vault.agentList(sessionId));
  const agentArgs = toolCallArguments(message);
  const parsed = VaultFillArgumentsSchema.safeParse(agentArgs);
  if (!parsed.success) {
    return answer(
      message.id,
      `The arguments of vault_fill are not valid: ${z.prettifyError(parsed.error)}`,
      true,
    );
  }
  let lookup;
  try {
    lookup = vault.fillValue(sessionId, parsed.data.credentialId, parsed.data.field);
  } catch (err) {
    if (err instanceof VaultDecryptError) {
      logError(err);
      return answer(message.id, 'The vault value cannot be read.', true);
    }
    throw err;
  }
  if (!lookup.ok) return answer(message.id, lookup.message, true);
  const hydraFill: HydraFill = { value: lookup.fill.value, ...lookup.fill.match };
  const params = isObject(message.params) ? message.params : {};
  const forward = {
    jsonrpc: '2.0',
    id: message.id,
    method: 'tools/call',
    params: { ...params, arguments: { ...(isObject(agentArgs) ? agentArgs : {}), hydraFill } },
  };
  return {
    kind: 'forward',
    body: Buffer.from(JSON.stringify(forward), 'utf8'),
    waitMs: lookup.fill.waitMs,
  };
}
