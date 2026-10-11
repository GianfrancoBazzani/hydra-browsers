import type {
  Action,
  AuditEvent,
  Me,
  Member,
  SessionResource,
  Token,
  UserSummary,
} from '@hydra/shared';

/** 2026-10-10 09:00 UTC. */
export const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

export const SID = 'q2w3e4r5t6y7';
export const SID_2 = 'z7x6c5v4b3n2';

export const ANA_ID = '01J9ZB3K8M2N4P6Q8R0S2T4V6W';
export const BEN_ID = '01J9ZB3K8M2N4P6Q8R0S2T4V6X';

export const VIEWER_RIGHTS: Action[] = ['session.read', 'live.watch'];
export const OPERATOR_RIGHTS: Action[] = [
  ...VIEWER_RIGHTS,
  'live.control',
  'session.lifecycle',
  'session.logs',
  'token.create',
  'token.revoke_own',
  'audit.read',
];
export const OWNER_RIGHTS: Action[] = [
  ...OPERATOR_RIGHTS,
  'token.revoke_any',
  'session.update',
  'session.share',
  'session.delete',
];

export function makeMe(overrides: Partial<Me> = {}): Me {
  return {
    id: ANA_ID,
    email: 'ana@example.com',
    displayName: 'Ana',
    role: 'member',
    mustChangePassword: false,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionResource> = {}): SessionResource {
  return {
    id: SID,
    name: 'Banking',
    owner: { id: ANA_ID, email: 'ana@example.com', displayName: 'Ana' },
    myRole: 'owner',
    rights: OWNER_RIGHTS,
    state: 'running',
    errorReason: null,
    settings: {
      allowlist: ['example.com'],
      timezone: 'Europe/Rome',
      language: 'it-IT',
      screen: '1920x1080',
    },
    restartRequired: false,
    agentActivity: { activeAgentCount: 0, lastToolCall: null },
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

export function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: '01J9ZC0000000000000000TKN1',
    name: 'laptop',
    prefix: 'hyd_AbCdEfGh…',
    createdBy: { id: ANA_ID, displayName: 'Ana' },
    createdAt: T0,
    expiresAt: T0 + 30 * 86_400_000,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

export function makeMember(overrides: Partial<Member> = {}): Member {
  return {
    userId: BEN_ID,
    email: 'ben@example.com',
    displayName: 'Ben',
    role: 'viewer',
    ...overrides,
  };
}

export function makeUser(overrides: Partial<UserSummary> = {}): UserSummary {
  return {
    id: BEN_ID,
    email: 'ben@example.com',
    displayName: 'Ben',
    role: 'member',
    status: 'active',
    locked: false,
    lastLoginAt: T0,
    createdAt: T0,
    ...overrides,
  };
}

export function makeAuditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 100,
    ts: T0,
    kind: 'mcp.tool_call',
    actorType: 'token',
    actorId: '01J9ZC0000000000000000TKN1',
    actorName: 'laptop',
    sessionId: SID,
    status: 'ok',
    data: { tool: 'browser_click', durationMs: 230 },
    ...overrides,
  };
}
