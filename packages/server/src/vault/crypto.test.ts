import { describe, expect, it } from 'vitest';
import { VaultDecryptError, decryptValue, encryptValue, type ValueAad } from './crypto.js';

const KEY = Buffer.alloc(32, 7);
const AAD: ValueAad = {
  sessionId: 'abcdefghijkl',
  credentialId: '01J9ZC0000000000000000CRD1',
  field: 'password',
};

describe('vault encryption', () => {
  it('round-trips a value, with a new nonce at each write', () => {
    const one = encryptValue(KEY, AAD, 'pässwörd "\\ 🔑');
    const two = encryptValue(KEY, AAD, 'pässwörd "\\ 🔑');
    expect(one[0]).toBe(0x01);
    expect(one.equals(two)).toBe(false);
    expect(decryptValue(KEY, AAD, one)).toBe('pässwörd "\\ 🔑');
  });

  it('fails for another session, credential, field, key, or a changed byte', () => {
    const blob = encryptValue(KEY, AAD, 'secret');
    expect(() => decryptValue(KEY, { ...AAD, sessionId: 'zzzzzzzzzzzz' }, blob)).toThrow(
      VaultDecryptError,
    );
    expect(() =>
      decryptValue(KEY, { ...AAD, credentialId: '01J9ZC0000000000000000CRD2' }, blob),
    ).toThrow(VaultDecryptError);
    expect(() => decryptValue(KEY, { ...AAD, field: 'username' }, blob)).toThrow(VaultDecryptError);
    expect(() => decryptValue(Buffer.alloc(32, 8), AAD, blob)).toThrow(VaultDecryptError);
    const changed = Buffer.from(blob);
    changed[20] = (changed[20] ?? 0) ^ 1;
    expect(() => decryptValue(KEY, AAD, changed)).toThrow(VaultDecryptError);
    expect(() => decryptValue(KEY, AAD, Buffer.from([0x02, ...blob.subarray(1)]))).toThrow(
      VaultDecryptError,
    );
    expect(() => decryptValue(KEY, AAD, Buffer.alloc(10))).toThrow(VaultDecryptError);
    expect(() => decryptValue(KEY, AAD, Buffer.alloc(10))).toThrow(
      `credential ${AAD.credentialId}`,
    );
  });
});
