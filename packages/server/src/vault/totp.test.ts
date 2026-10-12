import type { TotpParams } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import { totpAt, totpForFill } from './totp.js';

/** RFC 4648 base32 without padding (test helper only). */
function base32(text: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const byte of Buffer.from(text, 'ascii')) bits += byte.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5)
    out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

const SEEDS = {
  SHA1: base32('12345678901234567890'),
  SHA256: base32('12345678901234567890123456789012'),
  SHA512: base32('1234567890123456789012345678901234567890123456789012345678901234'),
} as const;

// RFC 6238 Appendix B (8 digits, 30 s).
const VECTORS: Array<[number, string, string, string]> = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

function params(algorithm: keyof typeof SEEDS, digits: 6 | 8 = 8): TotpParams {
  return { secret: SEEDS[algorithm], algorithm, digits, period: 30 };
}

describe('totpAt', () => {
  it('gives the RFC 6238 test vectors', () => {
    for (const [seconds, sha1, sha256, sha512] of VECTORS) {
      expect(totpAt(params('SHA1'), seconds * 1000).code).toBe(sha1);
      expect(totpAt(params('SHA256'), seconds * 1000).code).toBe(sha256);
      expect(totpAt(params('SHA512'), seconds * 1000).code).toBe(sha512);
    }
  });

  it('keeps leading zeros and gives the end of the period', () => {
    const result = totpAt(params('SHA1'), 1111111109 * 1000);
    expect(result.code).toBe('07081804');
    expect(result.validUntil).toBe(1111111110 * 1000);
    expect(totpAt(params('SHA1', 6), 1111111109 * 1000).code).toBe('081804');
  });
});

describe('totpForFill', () => {
  it('uses the current code if it is valid for 5 s or more', () => {
    expect(totpForFill(params('SHA1'), 1111111105 * 1000)).toEqual({ code: '07081804', waitMs: 0 });
  });

  it('waits for the next period if the code is valid for less than 5 s', () => {
    const now = 1111111107 * 1000; // 3 s before the period ends
    expect(totpForFill(params('SHA1'), now)).toEqual({
      code: totpAt(params('SHA1'), 1111111110 * 1000).code,
      waitMs: 3000,
    });
  });
});
