// Base32 of RFC 4648 for TOTP secrets (spec section 6.9.1). No Node.js APIs: the dashboard uses it too.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Removes spaces and "=", and changes to uppercase. Null if a character is not base32. */
export function normalizeBase32(input: string): string | null {
  const value = input.replace(/[\s=]/g, '').toUpperCase();
  return /^[A-Z2-7]*$/.test(value) ? value : null;
}

/** Decodes a normalized base32 value without padding. The bits after the last full byte are dropped. */
export function decodeBase32(value: string): Uint8Array {
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('The value is not base32.');
    buffer = ((buffer << 5) | index) & 0xfff; // at most 12 bits are waiting
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}
