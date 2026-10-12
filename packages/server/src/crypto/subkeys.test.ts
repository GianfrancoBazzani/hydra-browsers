import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { deriveSubkeys } from './subkeys.js';

const ROOT = Buffer.from(Array.from({ length: 32 }, (_, i) => i));

/** RFC 5869 HKDF-SHA256 for one output block, as an independent reference. */
function hkdfReference(rootKey: Buffer, info: string): Buffer {
  const prk = createHmac('sha256', Buffer.alloc(32)).update(rootKey).digest();
  return createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info), Buffer.from([1])]))
    .digest();
}

describe('deriveSubkeys', () => {
  it('derives each subkey with HKDF-SHA256 and the label of spec section 6.1', () => {
    const subkeys = deriveSubkeys(ROOT);
    expect(subkeys.passwordPepper).toEqual(hkdfReference(ROOT, 'hydra/password-pepper/v1'));
    expect(subkeys.loginSession).toEqual(hkdfReference(ROOT, 'hydra/login-session/v1'));
    expect(subkeys.liveGrant).toEqual(hkdfReference(ROOT, 'hydra/live-grant/v1'));
    expect(subkeys.agentToken).toEqual(hkdfReference(ROOT, 'hydra/agent-token/v1'));
    expect(subkeys.neko).toEqual(hkdfReference(ROOT, 'hydra/neko/v1'));
    expect(subkeys.vault).toEqual(hkdfReference(ROOT, 'hydra/vault/v1'));
  });

  it('matches the known-answer vectors', () => {
    const subkeys = deriveSubkeys(ROOT);
    expect(subkeys.passwordPepper.toString('hex')).toBe(
      'f3def2723770f852e1ac1b196e9a13974293574d3f5d5d0d72c942c52e3ab829',
    );
    expect(subkeys.neko.toString('hex')).toBe(
      'b3c69377547b764b08215b466da5664a0953d6426d8c72560690dbeae96f4ac9',
    );
  });

  it('gives five different 32-byte keys', () => {
    const subkeys = deriveSubkeys(ROOT);
    const keys = [
      subkeys.passwordPepper,
      subkeys.loginSession,
      subkeys.liveGrant,
      subkeys.agentToken,
      subkeys.neko,
    ];
    expect(keys).toHaveLength(5);
    expect(keys.every((key) => key.length === 32)).toBe(true);
    expect(new Set(keys.map((key) => key.toString('hex'))).size).toBe(5);
  });

  it('is deterministic, and another root key gives other subkeys', () => {
    expect(deriveSubkeys(ROOT)).toEqual(deriveSubkeys(Buffer.from(ROOT)));
    const other = deriveSubkeys(Buffer.alloc(32, 0xff));
    expect(other.agentToken.equals(deriveSubkeys(ROOT).agentToken)).toBe(false);
  });

  it('rejects a root key of less than 32 bytes', () => {
    expect(() => deriveSubkeys(Buffer.alloc(31))).toThrow(RangeError);
  });
});
