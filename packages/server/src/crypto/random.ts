import { randomBytes } from 'node:crypto';

export function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString('base64url');
}

/** A new HYDRA_SECRET_KEY: 32 random bytes in base64 (`hydra keygen`). */
export function generateRootKey(): string {
  return randomBytes(32).toString('base64');
}

const SID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const SID_LENGTH = 12;

/** Session ID: 12 random lowercase base32 characters (spec section 7.1). */
export function newSid(): string {
  // 256 is a multiple of 32, so `byte % 32` has no bias.
  return Array.from(randomBytes(SID_LENGTH), (byte) => SID_ALPHABET.charAt(byte % 32)).join('');
}

const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** 62^43 > 2^256, so 43 base62 digits hold 32 bytes. */
const TOKEN_BODY_LENGTH = 43;
export const AGENT_TOKEN_PREFIX = 'hyd_';
export const AGENT_TOKEN_PATTERN = /^hyd_[0-9A-Za-z]{43}$/;

/**
 * Agent token (spec section 6.6): `hyd_` + base62 of 32 random bytes, always 43 digits.
 * `prefix` is what the UI shows after creation: `hyd_` + the first 8 digits + `…`.
 */
export function newAgentToken(): { token: string; prefix: string } {
  let value = BigInt(`0x${randomBytes(32).toString('hex')}`);
  let body = '';
  for (let i = 0; i < TOKEN_BODY_LENGTH; i++) {
    body = BASE62_ALPHABET.charAt(Number(value % 62n)) + body;
    value /= 62n;
  }
  return { token: AGENT_TOKEN_PREFIX + body, prefix: `${AGENT_TOKEN_PREFIX}${body.slice(0, 8)}…` };
}
