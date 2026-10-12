import { describe, expect, it } from 'vitest';
import { checkTotpParams, parseOtpauthUri } from './otpauth.js';

const SECRET = 'JBSWY3DPEHPK3PXP';

describe('parseOtpauthUri', () => {
  it('reads secret, algorithm, digits, and period', () => {
    expect(
      parseOtpauthUri(
        `otpauth://totp/Example:alice@example.com?secret=${SECRET}&issuer=Example&algorithm=sha256&digits=8&period=60`,
      ),
    ).toEqual({
      ok: true,
      params: { secret: SECRET, algorithm: 'SHA256', digits: 8, period: 60 },
    });
  });

  it('uses the defaults SHA1, 6 digits, 30 s', () => {
    expect(parseOtpauthUri(`otpauth://totp/x?secret=${SECRET.toLowerCase()}`)).toEqual({
      ok: true,
      params: { secret: SECRET, algorithm: 'SHA1', digits: 6, period: 30 },
    });
  });

  it('rejects hotp, other URI kinds, and a missing secret', () => {
    expect(parseOtpauthUri(`otpauth://hotp/x?secret=${SECRET}&counter=1`)).toEqual({
      ok: false,
      message: 'HOTP codes are not supported. Use a TOTP secret.',
    });
    expect(parseOtpauthUri(`https://example.com/?secret=${SECRET}`).ok).toBe(false);
    expect(parseOtpauthUri('otpauth://totp/x')).toEqual({
      ok: false,
      message: 'The URI has no secret.',
    });
    expect(parseOtpauthUri('not a uri').ok).toBe(false);
  });
});

describe('checkTotpParams', () => {
  it('rejects short secrets and values that are not permitted', () => {
    expect(checkTotpParams({ secret: 'JBSWY3DP' })).toEqual({
      ok: false,
      message: 'The secret must have 16 to 128 base32 characters.',
    });
    expect(checkTotpParams({ secret: `${SECRET}!` })).toEqual({
      ok: false,
      message: 'The secret must be base32 (letters A to Z and digits 2 to 7).',
    });
    expect(checkTotpParams({ secret: SECRET, algorithm: 'MD5' }).ok).toBe(false);
    expect(checkTotpParams({ secret: SECRET, digits: 7 }).ok).toBe(false);
    expect(checkTotpParams({ secret: SECRET, period: 45 }).ok).toBe(false);
  });
});
