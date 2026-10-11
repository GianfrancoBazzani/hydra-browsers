import { describe, expect, it } from 'vitest';
import { deriveSubkeys, nekoPassword } from '../crypto/index.js';
import type { LiveGrant } from './types.js';
import { createNekoLoginStrategy, nekoUsername } from './neko-login.js';

const subkeys = deriveSubkeys(Buffer.alloc(32, 7));
const grant = (nekoProfile: LiveGrant['nekoProfile']): LiveGrant => ({
  id: 'G1',
  loginSessionId: 'L1',
  userId: 'U1',
  sessionId: 'abcdefgh2345',
  nekoProfile,
  createdAt: 0,
  expiresAt: 1,
});

describe('queryRewrite strategy', () => {
  const strategy = createNekoLoginStrategy({ subkeys });

  it('is the main path of spec section 9.2 step 4', () => {
    expect(strategy.name).toBe('queryRewrite');
    expect(nekoUsername('admin', 'Ada')).toBe('Ada');
  });

  it('sets username to the display name and password to the Neko password of the profile', async () => {
    for (const profile of ['admin', 'user'] as const) {
      const patch = await strategy.forUpgrade({
        grant: grant(profile),
        displayName: 'Ada Lovelace',
        endpoint: 'http://pod:8080',
      });
      expect(patch).toEqual({
        query: {
          username: 'Ada Lovelace',
          password: nekoPassword(subkeys.neko, 'abcdefgh2345', profile),
        },
        headers: {},
      });
    }
    const admin = await strategy.forUpgrade({
      grant: grant('admin'),
      displayName: 'A',
      endpoint: 'http://pod:8080',
    });
    const user = await strategy.forUpgrade({
      grant: grant('user'),
      displayName: 'A',
      endpoint: 'http://pod:8080',
    });
    expect(admin.query.password).not.toBe(user.query.password);
  });

  it('changes nothing in HTTP requests', async () => {
    expect(
      await strategy.forHttp({
        grant: grant('admin'),
        displayName: 'A',
        endpoint: 'http://pod:8080',
      }),
    ).toEqual({
      query: {},
      headers: {},
    });
    expect(() => {
      strategy.forget('G1');
    }).not.toThrow();
  });
});
