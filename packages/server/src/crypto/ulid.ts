import { randomBytes } from 'node:crypto';
import type { Clock } from '../lib/clock.js';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, in ASCII order
const MAX_TIME = 2 ** 48 - 1;

/**
 * A ULID: 10 characters of time (ms) and 16 characters of randomness. IDs sort by time.
 * IDs of the same millisecond are not ordered (monotonic mode is not needed).
 */
export function newUlid(clock: Clock): string {
  let time = clock.now();
  if (!Number.isSafeInteger(time) || time < 0 || time > MAX_TIME) {
    throw new RangeError(`Cannot encode the time ${String(time)} in a ULID`);
  }
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING.charAt(time % 32) + timePart;
    time = Math.floor(time / 32);
  }
  let random = BigInt(`0x${randomBytes(10).toString('hex')}`);
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart = ENCODING.charAt(Number(random & 31n)) + randomPart;
    random >>= 5n;
  }
  return timePart + randomPart;
}

/** The time (ms) in a ULID. */
export function ulidTime(id: string): number {
  let time = 0;
  for (const char of id.slice(0, 10)) {
    const value = ENCODING.indexOf(char);
    if (value < 0) throw new RangeError(`Not a ULID: ${id}`);
    time = time * 32 + value;
  }
  return time;
}
