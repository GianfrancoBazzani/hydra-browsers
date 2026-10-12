import { describe, expect, it } from 'vitest';
import { createRedactor, vaultLabel } from './redaction.js';

const ID = '01J9ZC0000000000000000CRD1';

describe('createRedactor', () => {
  it('is empty without entries', () => {
    expect(createRedactor([]).empty).toBe(true);
  });

  it('replaces values in one pass, longer values first, and does not change the labels', () => {
    const redactor = createRedactor([
      { value: 'vault', label: vaultLabel(ID, 'username') },
      { value: 'vaultpass', label: vaultLabel(ID, 'password') },
    ]);
    expect(redactor.text('user vault, pass vaultpass')).toBe(
      `user [vault:${ID}.username], pass [vault:${ID}.password]`,
    );
  });

  it('replaces the JSON-escaped form', () => {
    const value = 'p"a\\ss é🔑';
    const redactor = createRedactor([{ value, label: vaultLabel(ID, 'password') }]);
    const snapshot = `- textbox "Password": ${JSON.stringify(value)}`;
    const message = {
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: snapshot }] },
    };
    const out = JSON.parse(redactor.json(JSON.stringify(message))) as typeof message;
    expect(out.result.content[0]?.text).toBe(`- textbox "Password": "[vault:${ID}.password]"`);
  });

  it('changes only result, error, and params, and never image data', () => {
    const redactor = createRedactor([{ value: 'hunter22', label: vaultLabel(ID, 'password') }]);
    const message = {
      jsonrpc: '2.0',
      id: 'hunter22',
      method: 'hunter22',
      result: {
        content: [
          { type: 'text', text: 'pw hunter22' },
          { type: 'image', data: 'hunter22', mimeType: 'image/png' },
        ],
      },
    };
    expect(JSON.parse(redactor.json(JSON.stringify(message)))).toEqual({
      ...message,
      result: {
        content: [
          { type: 'text', text: `pw [vault:${ID}.password]` },
          { type: 'image', data: 'hunter22', mimeType: 'image/png' },
        ],
      },
    });
    const batch = JSON.stringify([
      { jsonrpc: '2.0', id: 2, error: { code: 1, message: 'x hunter22' } },
    ]);
    expect(redactor.json(batch)).toContain(`x [vault:${ID}.password]`);
  });

  it('replaces the raw text if the body is not JSON', () => {
    const redactor = createRedactor([{ value: 'hunter22', label: vaultLabel(ID, 'password') }]);
    expect(redactor.json('oops hunter22 {')).toBe(`oops [vault:${ID}.password] {`);
  });
});
