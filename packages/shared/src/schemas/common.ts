import { z } from 'zod';

/** Milliseconds since the Unix epoch. */
export const TimestampSchema = z.number().int().nonnegative();

/** A ULID: 26 characters of Crockford base32 (all IDs except the session ID). */
export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'Invalid ID');

/** A session ID: 12 characters of lowercase base32 (spec section 7.1). */
export const SidSchema = z.string().regex(/^[a-z2-7]{12}$/, 'Invalid session ID');

/** An email address, trimmed and lowercase (the database keeps emails in lowercase). */
export const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email must have at most 254 characters')
  .pipe(z.email('Invalid email address'));

export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, 'Name must have 1 to 64 characters')
  .max(64, 'Name must have 1 to 64 characters');
