// TOTP codes (spec section 6.9.4): RFC 6238 with the dynamic truncation of RFC 4226. No dependency.
import { createHmac } from 'node:crypto';
import { TOTP_FILL_MIN_REMAINING_MS, decodeBase32, type TotpParams } from '@hydra/shared';

export interface TotpCode {
  code: string;
  /** The time (ms) at which the code stops being valid: the end of its period. */
  validUntil: number;
}

/** The code of the period that contains `timeMs`. */
export function totpAt(params: TotpParams, timeMs: number): TotpCode {
  const periodMs = params.period * 1000;
  const counter = Math.floor(timeMs / periodMs);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(
    params.algorithm.toLowerCase(),
    Buffer.from(decodeBase32(params.secret)),
  )
    .update(message)
    .digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  const code = String(binary % 10 ** params.digits).padStart(params.digits, '0');
  return { code, validUntil: (counter + 1) * periodMs };
}

/**
 * The code for a fill. If the current code is valid for less than 5 s more, the code of the next
 * period, and the time until that period starts (the gateway waits before it sends the fill).
 */
export function totpForFill(params: TotpParams, nowMs: number): { code: string; waitMs: number } {
  const current = totpAt(params, nowMs);
  const remaining = current.validUntil - nowMs;
  if (remaining >= TOTP_FILL_MIN_REMAINING_MS) return { code: current.code, waitMs: 0 };
  return { code: totpAt(params, current.validUntil).code, waitMs: remaining };
}
