import { z } from 'zod';
import {
  REVEAL_FIELDS,
  VAULT_FIELDS,
  VAULT_NAME_MAX_LENGTH,
  VAULT_PASSWORD_MAX_LENGTH,
  VAULT_USERNAME_MAX_LENGTH,
} from '../constants.js';
import { checkTotpParams, parseOtpauthUri, type TotpParams } from '../vault/otpauth.js';
import { normalizeWebsite } from '../vault/site.js';
import { VAULT_REF_PATTERN } from '../vault/tools.js';
import { TimestampSchema, UlidSchema } from './common.js';

const NAME_RULE = `Name must have 1 to ${String(VAULT_NAME_MAX_LENGTH)} characters`;
export const CredentialNameSchema = z
  .string()
  .trim()
  .min(1, NAME_RULE)
  .max(VAULT_NAME_MAX_LENGTH, NAME_RULE);

/** The origin of the website (spec section 6.9.1). The gateway checks the http rule. */
export const WebsiteSchema = z
  .string()
  .max(2048, 'The address is too long')
  .transform((value, ctx) => {
    const url = normalizeWebsite(value);
    if (url === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'Enter an https address, for example https://www.google.com',
      });
      return z.NEVER;
    }
    return url.origin;
  });

const USERNAME_RULE = `The username must have 1 to ${String(VAULT_USERNAME_MAX_LENGTH)} characters`;
export const UsernameSchema = z
  .string()
  .min(1, USERNAME_RULE)
  .max(VAULT_USERNAME_MAX_LENGTH, USERNAME_RULE);

const PASSWORD_RULE = `The password must have 1 to ${String(VAULT_PASSWORD_MAX_LENGTH)} characters`;
export const VaultPasswordSchema = z
  .string()
  .min(1, PASSWORD_RULE)
  .max(VAULT_PASSWORD_MAX_LENGTH, PASSWORD_RULE);

/** An otpauth://totp/ URI, or a base32 secret with optional parameters (spec section 6.9.1). */
export const TotpInputSchema = z
  .union([
    z.strictObject({ uri: z.string().max(4096) }),
    z.strictObject({
      secret: z.string().max(512),
      algorithm: z.string().max(16).optional(),
      digits: z.number().int().optional(),
      period: z.number().int().optional(),
    }),
  ])
  .transform((input, ctx): TotpParams => {
    const check = 'uri' in input ? parseOtpauthUri(input.uri) : checkTotpParams(input);
    if (!check.ok) {
      ctx.addIssue({ code: 'custom', message: check.message });
      return z.NEVER;
    }
    return check.params;
  });

export const CreateCredentialRequestSchema = z
  .object({
    name: CredentialNameSchema,
    website: WebsiteSchema,
    username: UsernameSchema.optional(),
    password: VaultPasswordSchema.optional(),
    totp: TotpInputSchema.optional(),
  })
  .refine(
    (value) =>
      value.username !== undefined || value.password !== undefined || value.totp !== undefined,
    { message: 'Set a username, a password, or a two-factor secret.', path: ['username'] },
  );
export type CreateCredentialInput = z.input<typeof CreateCredentialRequestSchema>;
export type CreateCredentialRequest = z.output<typeof CreateCredentialRequestSchema>;

/** A missing key keeps the value, null removes an optional value (spec section 12.1). */
export const UpdateCredentialRequestSchema = z.object({
  name: CredentialNameSchema.optional(),
  website: WebsiteSchema.optional(),
  username: UsernameSchema.nullable().optional(),
  password: VaultPasswordSchema.nullable().optional(),
  totp: TotpInputSchema.nullable().optional(),
});
export type UpdateCredentialInput = z.input<typeof UpdateCredentialRequestSchema>;
export type UpdateCredentialRequest = z.output<typeof UpdateCredentialRequestSchema>;

/** Metadata of a credential (spec section 6.9.5). Never a password or a TOTP secret. */
export const CredentialSchema = z.object({
  id: UlidSchema,
  name: z.string(),
  website: z.string(),
  matchDomain: z.string(),
  matchSubdomains: z.boolean(),
  username: z.string().nullable(),
  hasPassword: z.boolean(),
  hasTotp: z.boolean(),
  createdBy: z.object({ id: z.string(), displayName: z.string() }),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Credential = z.infer<typeof CredentialSchema>;

export const RevealRequestSchema = z.object({ field: z.enum(REVEAL_FIELDS) });
export type RevealRequest = z.infer<typeof RevealRequestSchema>;

export const RevealResponseSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('password'), value: z.string() }),
  z.object({
    field: z.literal('totp'),
    code: z.string(),
    validUntil: TimestampSchema,
    period: z.number().int(),
  }),
]);
export type RevealResponse = z.infer<typeof RevealResponseSchema>;

/** Arguments of vault_fill from the agent (spec section 8.8.1). */
export const VaultFillArgumentsSchema = z.object({
  credentialId: UlidSchema,
  field: z.enum(VAULT_FIELDS),
  target: z
    .string()
    .regex(VAULT_REF_PATTERN, 'target must be a ref from a page snapshot, for example e12'),
  element: z.string().max(500).optional(),
  submit: z.boolean().optional(),
  slowly: z.boolean().optional(),
});
export type VaultFillArguments = z.infer<typeof VaultFillArgumentsSchema>;

/** What the gateway adds to a vault_fill call (spec section 8.8.2 step 5). */
export const HydraFillSchema = z.object({
  value: z.string().min(1),
  scheme: z.enum(['https:', 'http:']),
  matchDomain: z.string().min(1),
  matchSubdomains: z.boolean(),
});
export type HydraFill = z.infer<typeof HydraFillSchema>;
