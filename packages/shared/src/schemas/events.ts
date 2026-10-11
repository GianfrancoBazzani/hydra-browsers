import { z } from 'zod';
import { SESSION_STATES } from '../constants.js';
import { AgentActivitySchema } from './session.js';

/** SSE event `session.state`. */
export const SessionStateEventSchema = z.object({
  sessionId: z.string(),
  state: z.enum(SESSION_STATES),
  errorReason: z.string().nullable(),
});
export type SessionStateEvent = z.infer<typeof SessionStateEventSchema>;

/** SSE event `session.activity`. */
export const SessionActivityEventSchema = z.object({
  sessionId: z.string(),
  agentActivity: AgentActivitySchema,
});
export type SessionActivityEvent = z.infer<typeof SessionActivityEventSchema>;
