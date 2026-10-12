import { describe, expect, it } from 'vitest';
import { decodeBase32, normalizeBase32 } from './base32.js';

describe('base32', () => {
  it('removes spaces and "=" and changes to uppercase', () => {
    expect(normalizeBase32(' jbsw y3dp ehpk 3pxp== ')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('rejects characters that are not base32', () => {
    expect(normalizeBase32('JBSWY3DP1')).toBeNull();
    expect(normalizeBase32('JBSW-Y3DP')).toBeNull();
  });

  it('decodes RFC 4648 test vectors', () => {
    const text = (value: string) => new TextDecoder().decode(decodeBase32(value));
    expect(text('MZXW6')).toBe('foo');
    expect(text('MZXW6YQ')).toBe('foob');
    expect(text('MZXW6YTBOI')).toBe('foobar');
    expect(text('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')).toBe('12345678901234567890');
  });
});
