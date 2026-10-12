import type { AuditKind } from '@hydra/shared';

/** Filters of the Activity view (spec section 12.1, GET /api/sessions/:sid/audit). */
export interface AuditFilters {
  kind?: AuditKind;
  tool?: string;
  status?: 'pending' | 'ok' | 'error';
  tokenId?: string;
}

/** All TanStack Query keys. Each key under `sessions` belongs to the session data. */
export const queryKeys = {
  me: ['me'] as const,
  sessions: ['sessions'] as const,
  sessionLists: ['sessions', 'list'] as const,
  sessionList: (all: boolean) => ['sessions', 'list', all ? 'all' : 'mine'] as const,
  session: (sid: string) => ['sessions', 'detail', sid] as const,
  members: (sid: string) => ['sessions', 'members', sid] as const,
  tokens: (sid: string) => ['sessions', 'tokens', sid] as const,
  vault: (sid: string) => ['sessions', 'vault', sid] as const,
  auditAll: (sid: string) => ['sessions', 'audit', sid] as const,
  audit: (sid: string, filters: AuditFilters) => ['sessions', 'audit', sid, filters] as const,
  logs: (sid: string, container: 'neko' | 'mcp') => ['sessions', 'logs', sid, container] as const,
  users: ['users'] as const,
};
