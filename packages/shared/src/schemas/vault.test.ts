import { describe, expect, it } from 'vitest';
import {
  CreateCredentialRequestSchema,
  HydraFillSchema,
  UpdateCredentialRequestSchema,
  VaultFillArgumentsSchema,
} from './vault.js';

const SECRET = 'JBSWY3DPEHPK3PXP';
const ID = '01J9ZC0000000000000000CRD1';

describe('vault schemas', () => {
  it('parses a create request and normalizes the website and the TOTP input', () => {
    const parsed = CreateCredentialRequestSchema.parse({
      name: '  Google - Catalina ',
      website: 'www.google.com/x',
      username: 'catalina@example.com',
      password: ' p a s s ',
      totp: { uri: `otpauth://totp/x?secret=${SECRET}` },
    });
    expect(parsed).toEqual({
      name: 'Google - Catalina',
      website: 'https://www.google.com',
      username: 'catalina@example.com',
      password: ' p a s s ',
      totp: { secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 },
    });
  });

  it('needs a username, a password, or a TOTP secret', () => {
    const result = CreateCredentialRequestSchema.safeParse({ name: 'x', website: 'example.com' });
    expect(result.success).toBe(false);
  });

  it('accepts a base32 secret with parameters, and reports a bad secret on the totp field', () => {
    expect(
      CreateCredentialRequestSchema.parse({
        name: 'x',
        website: 'example.com',
        totp: { secret: 'jbsw y3dp ehpk 3pxp', digits: 8 },
      }).totp,
    ).toEqual({ secret: SECRET, algorithm: 'SHA1', digits: 8, period: 30 });
    const bad = CreateCredentialRequestSchema.safeParse({
      name: 'x',
      website: 'example.com',
      totp: { secret: 'short' },
    });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['totp']);
  });

  it('keeps null in an update request (remove a value)', () => {
    expect(UpdateCredentialRequestSchema.parse({ password: null, totp: null })).toEqual({
      password: null,
      totp: null,
    });
  });

  it('validates the vault_fill arguments and hydraFill', () => {
    expect(
      VaultFillArgumentsSchema.parse({ credentialId: ID, field: 'password', target: 'f1e12' }),
    ).toEqual({ credentialId: ID, field: 'password', target: 'f1e12' });
    expect(
      VaultFillArgumentsSchema.safeParse({ credentialId: ID, field: 'password', target: '#pw' })
        .success,
    ).toBe(false);
    expect(
      HydraFillSchema.safeParse({
        value: 'x',
        scheme: 'https:',
        matchDomain: 'google.com',
        matchSubdomains: true,
      }).success,
    ).toBe(true);
  });
});
