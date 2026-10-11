import { z } from 'zod';
import { DEFAULT_TOKEN_EXPIRY_DAYS, TOKEN_EXPIRY_DAYS } from '../constants.js';
import { TimestampSchema } from './common.js';

/**
 * The token name is also the MCP server name in the `claude mcp add` command of the Tokens view
 * (spec section 10.2), so it uses only characters that are safe in that command.
 */
export const TokenNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use 1 to 64 letters, digits, "-", or "_"');

export const TokenExpiryDaysSchema = z.literal(TOKEN_EXPIRY_DAYS);

export const TokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  createdBy: z.object({ id: z.string(), displayName: z.string() }),
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  lastUsedAt: TimestampSchema.nullable(),
  revokedAt: TimestampSchema.nullable(),
});
export type Token = z.infer<typeof TokenSchema>;

export const CreateTokenRequestSchema = z.object({
  name: TokenNameSchema,
  expiresInDays: TokenExpiryDaysSchema.default(DEFAULT_TOKEN_EXPIRY_DAYS),
});
export type CreateTokenRequest = z.infer<typeof CreateTokenRequestSchema>;

/** `secret` is the full token (`hyd_…`). The API returns it one time. */
export const CreateTokenResponseSchema = z.object({ token: TokenSchema, secret: z.string() });
export type CreateTokenResponse = z.infer<typeof CreateTokenResponseSchema>;
