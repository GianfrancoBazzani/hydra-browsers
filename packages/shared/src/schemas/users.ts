import { z } from 'zod';
import { GLOBAL_ROLES, USER_STATUSES } from '../constants.js';
import { DisplayNameSchema, EmailSchema, TimestampSchema } from './common.js';

export const UserSummarySchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(GLOBAL_ROLES),
  status: z.enum(USER_STATUSES),
  locked: z.boolean(),
  lastLoginAt: TimestampSchema.nullable(),
  createdAt: TimestampSchema,
});
export type UserSummary = z.infer<typeof UserSummarySchema>;

export const CreateUserRequestSchema = z.object({
  email: EmailSchema,
  displayName: DisplayNameSchema,
  role: z.enum(GLOBAL_ROLES),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const CreateUserResponseSchema = z.object({
  user: UserSummarySchema,
  oneTimePassword: z.string(),
});
export type CreateUserResponse = z.infer<typeof CreateUserResponseSchema>;

export const UpdateUserRequestSchema = z.object({
  role: z.enum(GLOBAL_ROLES).optional(),
  status: z.enum(USER_STATUSES).optional(),
  displayName: DisplayNameSchema.optional(),
});
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const ResetPasswordResponseSchema = z.object({ oneTimePassword: z.string() });
export type ResetPasswordResponse = z.infer<typeof ResetPasswordResponseSchema>;
