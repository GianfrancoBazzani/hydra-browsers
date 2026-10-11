import { createHmac } from 'node:crypto';

/** HMAC-SHA256 of the UTF-8 bytes of `value`. */
export function hmac(key: Buffer, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}
