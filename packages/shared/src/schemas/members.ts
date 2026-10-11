import { z } from 'zod';
import { MEMBER_ROLES, SESSION_ROLES } from '../constants.js';
import { EmailSchema } from './common.js';

export const MemberSchema = z.object({
  userId: z.string(),
  email: z.string(),
  displayName: z.string(),
  role: z.enum(SESSION_ROLES),
});
export type Member = z.infer<typeof MemberSchema>;

export const MembersResponseSchema = z.object({
  owner: MemberSchema,
  members: z.array(MemberSchema),
});
export type MembersResponse = z.infer<typeof MembersResponseSchema>;

export const AddMemberRequestSchema = z.object({
  email: EmailSchema,
  role: z.enum(MEMBER_ROLES),
});
export type AddMemberRequest = z.infer<typeof AddMemberRequestSchema>;

export const UpdateMemberRequestSchema = z.object({ role: z.enum(MEMBER_ROLES) });
export type UpdateMemberRequest = z.infer<typeof UpdateMemberRequestSchema>;
