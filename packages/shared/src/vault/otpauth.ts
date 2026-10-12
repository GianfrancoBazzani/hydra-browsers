// TOTP input of a credential: an otpauth://totp/ URI, or a base32 secret with parameters (spec section 6.9.1).
import {
  TOTP_ALGORITHMS,
  TOTP_DIGITS,
  TOTP_PERIODS,
  TOTP_SECRET_MAX_LENGTH,
  TOTP_SECRET_MIN_LENGTH,
  type TotpAlgorithm,
  type TotpDigits,
  type TotpPeriod,
} from '../constants.js';
import { normalizeBase32 } from './base32.js';

export interface TotpParams {
  /** Normalized base32. */
  secret: string;
  algorithm: TotpAlgorithm;
  digits: TotpDigits;
  period: TotpPeriod;
}

export type TotpCheck = { ok: true; params: TotpParams } | { ok: false; message: string };

export interface TotpFields {
  secret: string;
  algorithm?: string | undefined;
  digits?: number | string | undefined;
  period?: number | string | undefined;
}

function fail(message: string): TotpCheck {
  return { ok: false, message };
}

/** Checks a secret and its parameters. Missing parameters get SHA1, 6 digits, 30 s. */
export function checkTotpParams(input: TotpFields): TotpCheck {
  const secret = normalizeBase32(input.secret);
  if (secret === null) return fail('The secret must be base32 (letters A to Z and digits 2 to 7).');
  if (secret.length < TOTP_SECRET_MIN_LENGTH || secret.length > TOTP_SECRET_MAX_LENGTH) {
    return fail('The secret must have 16 to 128 base32 characters.');
  }
  const algorithm = (input.algorithm ?? 'SHA1').toUpperCase();
  if (!(TOTP_ALGORITHMS as readonly string[]).includes(algorithm)) {
    return fail('The algorithm must be SHA1, SHA256, or SHA512.');
  }
  const digits = Number(input.digits ?? 6);
  if (!(TOTP_DIGITS as readonly number[]).includes(digits))
    return fail('The digits must be 6 or 8.');
  const period = Number(input.period ?? 30);
  if (!(TOTP_PERIODS as readonly number[]).includes(period)) {
    return fail('The period must be 30 or 60 seconds.');
  }
  return {
    ok: true,
    params: {
      secret,
      algorithm: algorithm as TotpAlgorithm,
      digits: digits as TotpDigits,
      period: period as TotpPeriod,
    },
  };
}

/** Reads secret, algorithm, digits, and period of an otpauth://totp/ URI. Other parameters are ignored. */
export function parseOtpauthUri(uri: string): TotpCheck {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return fail('Enter an otpauth://totp/ URI or a base32 secret.');
  }
  if (url.protocol !== 'otpauth:') return fail('Enter an otpauth://totp/ URI or a base32 secret.');
  const kind = url.hostname.toLowerCase();
  if (kind === 'hotp') return fail('HOTP codes are not supported. Use a TOTP secret.');
  if (kind !== 'totp') return fail('Enter an otpauth://totp/ URI or a base32 secret.');
  const secret = url.searchParams.get('secret');
  if (secret === null || secret === '') return fail('The URI has no secret.');
  const optional = (name: string): string | undefined => url.searchParams.get(name) ?? undefined;
  return checkTotpParams({
    secret,
    algorithm: optional('algorithm'),
    digits: optional('digits'),
    period: optional('period'),
  });
}
