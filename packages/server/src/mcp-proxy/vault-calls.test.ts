import { describe, expect, it } from 'vitest';
import type { FillLookup } from '../vault/index.js';
import { VaultDecryptError } from '../vault/index.js';
import { classifyMessage, type RequestMessage } from './jsonrpc.js';
import { isVaultCall, planVaultCall, withoutHydraFill } from './vault-calls.js';

const ID = '01J9ZC0000000000000000CRD1';

function call(name: string, args: unknown, id: number | string = 7): RequestMessage {
  const message = classifyMessage({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: { progressToken: 1 } },
  });
  if (message.kind !== 'request') throw new Error('not a request');
  return message;
}

function fakeVault(lookup: FillLookup | Error, list = '- list') {
  return {
    agentList: () => list,
    fillValue: () => {
      if (lookup instanceof Error) throw lookup;
      return lookup;
    },
  };
}

const OK: FillLookup = {
  ok: true,
  fill: {
    value: 'hunter22',
    match: { scheme: 'https:', matchDomain: 'a.com', matchSubdomains: true },
    waitMs: 1200,
  },
};

describe('vault calls', () => {
  it('knows the vault tool calls', () => {
    expect(isVaultCall(call('vault_list', {}))).toBe(true);
    expect(isVaultCall(call('vault_fill', {}))).toBe(true);
    expect(isVaultCall(call('browser_click', {}))).toBe(false);
  });

  it('answers vault_list itself', () => {
    expect(planVaultCall(fakeVault(OK, '- a · b'), 'sid', call('vault_list', {}))).toEqual({
      kind: 'answer',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        result: { content: [{ type: 'text', text: '- a · b' }] },
      }),
    });
  });

  it('removes the hydraFill of the agent', () => {
    const message = withoutHydraFill(
      call('vault_fill', {
        credentialId: ID,
        field: 'password',
        target: 'e1',
        hydraFill: { value: 'x' },
      }),
    );
    expect(message).toMatchObject({
      params: { arguments: { credentialId: ID, field: 'password', target: 'e1' } },
    });
    expect(JSON.stringify(message)).not.toContain('hydraFill');
  });

  it('forwards vault_fill with hydraFill, the same id, and the other params', () => {
    const outcome = planVaultCall(
      fakeVault(OK),
      'sid',
      call('vault_fill', { credentialId: ID, field: 'password', target: 'e1' }, 'x-1'),
    );
    expect(outcome.kind).toBe('forward');
    if (outcome.kind !== 'forward') return;
    expect(outcome.waitMs).toBe(1200);
    expect(JSON.parse(outcome.body.toString('utf8'))).toEqual({
      jsonrpc: '2.0',
      id: 'x-1',
      method: 'tools/call',
      params: {
        name: 'vault_fill',
        _meta: { progressToken: 1 },
        arguments: {
          credentialId: ID,
          field: 'password',
          target: 'e1',
          hydraFill: {
            value: 'hunter22',
            scheme: 'https:',
            matchDomain: 'a.com',
            matchSubdomains: true,
          },
        },
      },
    });
  });

  it('answers a deleted credential, bad arguments, and a value that cannot be decrypted', () => {
    const missing = planVaultCall(
      fakeVault({
        ok: false,
        message: `Credential ${ID} does not exist in this session. Call vault_list.`,
      }),
      'sid',
      call('vault_fill', { credentialId: ID, field: 'password', target: 'e1' }),
    );
    expect(missing).toEqual({
      kind: 'answer',
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        result: {
          content: [
            {
              type: 'text',
              text: `Credential ${ID} does not exist in this session. Call vault_list.`,
            },
          ],
          isError: true,
        },
      }),
    });
    const bad = planVaultCall(
      fakeVault(OK),
      'sid',
      call('vault_fill', { credentialId: ID, field: 'password', target: '#css' }),
    );
    expect(bad.kind === 'answer' && bad.body).toContain(
      'The arguments of vault_fill are not valid:',
    );
    const broken = planVaultCall(
      fakeVault(new VaultDecryptError(ID)),
      'sid',
      call('vault_fill', { credentialId: ID, field: 'password', target: 'e1' }),
    );
    expect(broken.kind === 'answer' && broken.body).toContain('The vault value cannot be read.');
  });
});
