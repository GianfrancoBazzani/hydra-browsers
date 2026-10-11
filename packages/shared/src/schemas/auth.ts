import { z } from 'zod';
import { GLOBAL_ROLES } from '../constants.js';

export const MeSchema = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(GLOBAL_ROLES),
  mustChangePassword: z.boolean(),
});
export type Me = z.infer<typeof MeSchema>;

/** Loose on purpose: a wrong email gives 401 invalid_credentials, not 400. */
export const LoginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().min(1).max(254),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

/** The password rules (12 to 128 characters and more) are in the server: 400 password_rejected. */
export const ChangePasswordRequestSchema = z.object({
  current: z.string().min(1).max(1024),
  new: z.string().max(1024),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
