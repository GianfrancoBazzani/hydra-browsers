import { describe, expect, it } from 'vitest';
import { hmac } from './hmac.js';
import { nekoPassword } from './neko.js';
import {
  AGENT_TOKEN_PATTERN,
  generateRootKey,
  newAgentToken,
  newSid,
  randomBase64Url,
} from './random.js';
import { deriveSubkeys } from './subkeys.js';

describe('hmac', () => {
  it('is HMAC-SHA256 (RFC 4231 test case 2)', () => {
    expect(hmac(Buffer.from('Jefe'), 'what do ya want for nothing?').toString('hex')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('gives another value for another key', () => {
    expect(hmac(Buffer.alloc(32, 1), 'x').equals(hmac(Buffer.alloc(32, 2), 'x'))).toBe(false);
  });
});

describe('newAgentToken', () => {
  it('has the format hyd_ + 43 base62 characters', () => {
    for (let i = 0; i < 200; i++) {
      expect(newAgentToken().token).toMatch(AGENT_TOKEN_PATTERN);
    }
  });

  it('has the prefix hyd_ + the first 8 characters + …', () => {
    const { token, prefix } = newAgentToken();
    expect(prefix).toBe(`${token.slice(0, 12)}…`);
    expect(prefix).toMatch(/^hyd_[0-9A-Za-z]{8}…$/);
  });

  it('gives a new value each time', () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => newAgentToken().token));
    expect(tokens.size).toBe(1000);
  });

  it('stores only an HMAC that depends on the agent-token subkey', () => {
    const { token } = newAgentToken();
    const keys = deriveSubkeys(Buffer.alloc(32, 3));
    expect(hmac(keys.agentToken, token)).toHaveLength(32);
    expect(hmac(keys.agentToken, token).equals(hmac(keys.loginSession, token))).toBe(false);
  });
});

describe('nekoPassword', () => {
  const nekoKey = deriveSubkeys(Buffer.from(Array.from({ length: 32 }, (_, i) => i))).neko;

  it('is base64url(HMAC-SHA256(neko subkey, sid|profile))', () => {
    expect(nekoPassword(nekoKey, 'abcdefghijkl', 'admin')).toBe(
      'eMbdaajm7AMjGF5MsWb2tGiU1-SBI7bbk13tcvAJuPI',
    );
    expect(nekoPassword(nekoKey, 'abcdefghijkl', 'user')).toBe(
      'XPAgTlTSBdiejwYyldC_A467qevJ7XFIb69EbAczSKI',
    );
  });

  it('differs for each profile and each session, and is stable', () => {
    const admin = nekoPassword(nekoKey, 'abcdefghijkl', 'admin');
    expect(nekoPassword(nekoKey, 'abcdefghijkl', 'admin')).toBe(admin);
    expect(nekoPassword(nekoKey, 'abcdefghijkm', 'admin')).not.toBe(admin);
    expect(nekoPassword(nekoKey, 'abcdefghijkl', 'user')).not.toBe(admin);
  });
});

describe('random values', () => {
  it('newSid gives 12 lowercase base32 characters', () => {
    const sids = Array.from({ length: 500 }, () => newSid());
    for (const sid of sids) expect(sid).toMatch(/^[a-z2-7]{12}$/);
    expect(new Set(sids).size).toBe(500);
  });

  it('randomBase64Url encodes the given number of bytes', () => {
    expect(Buffer.from(randomBase64Url(32), 'base64url')).toHaveLength(32);
    expect(randomBase64Url(32)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('generateRootKey gives 32 random bytes in base64', () => {
    const key = generateRootKey();
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(generateRootKey()).not.toBe(key);
  });
});
