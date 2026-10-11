import { describe, expect, it } from 'vitest';
import { PasswordHasher } from './password.js';

const PEPPER = Buffer.alloc(32, 0x11);

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher(PEPPER);

  it('hashes with Argon2id m=64 MiB, t=3, p=1 and a 16-byte salt', async () => {
    const phc = await hasher.hash('correct horse battery staple');
    expect(phc).toMatch(
      /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(hasher.needsRehash(phc)).toBe(false);
  });

  it('uses a new salt for each hash', async () => {
    const [a, b] = await Promise.all([hasher.hash('same password'), hasher.hash('same password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the right password and rejects a wrong one', async () => {
    const phc = await hasher.hash('correct horse battery staple');
    expect(await hasher.verify(phc, 'correct horse battery staple')).toBe(true);
    expect(await hasher.verify(phc, 'correct horse battery stapler')).toBe(false);
  });

  it('uses the pepper: another pepper does not verify', async () => {
    const phc = await hasher.hash('correct horse battery staple');
    const other = new PasswordHasher(Buffer.alloc(32, 0x22));
    expect(await other.verify(phc, 'correct horse battery staple')).toBe(false);
  });

  it('returns false for a stored value that is not a PHC string', async () => {
    expect(await hasher.verify('not a hash', 'x')).toBe(false);
  });

  it('verifyDummy is always false', async () => {
    expect(await hasher.verifyDummy('correct horse battery staple')).toBe(false);
  });

  it('needsRehash is true for other parameters or algorithms', () => {
    const b64 = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');
    const salt = b64(Buffer.alloc(16, 1));
    const out = b64(Buffer.alloc(32, 2));
    expect(hasher.needsRehash(`$argon2id$v=19$m=19456,t=2,p=1$${salt}$${out}`)).toBe(true);
    expect(hasher.needsRehash(`$argon2i$v=19$m=65536,t=3,p=1$${salt}$${out}`)).toBe(true);
    expect(hasher.needsRehash(`$argon2id$v=19$m=65536,t=3,p=1$${salt}$${out}`)).toBe(false);
    expect(hasher.needsRehash('garbage')).toBe(true);
  });
});
