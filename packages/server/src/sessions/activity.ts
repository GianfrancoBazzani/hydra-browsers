import type { AgentActivity } from '@hydra/shared';

/** Agent activity summary of a session (spec section 8.5). Plan 05 replaces noActivity with ActivityTracker. */
export interface ActivityProvider {
  get(sessionId: string): AgentActivity;
}

export const noActivity: ActivityProvider = {
  get: () => ({ activeAgentCount: 0, lastToolCall: null }),
};
