export const GLOBAL_ROLES = ['admin', 'member'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const USER_STATUSES = ['active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const SESSION_ROLES = ['owner', 'operator', 'viewer'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export const MEMBER_ROLES = ['operator', 'viewer'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const NEKO_PROFILES = ['admin', 'user'] as const;
export type NekoProfile = (typeof NEKO_PROFILES)[number];

export const ACTIONS = [
  'session.read',
  'live.watch',
  'live.control',
  'session.lifecycle',
  'session.logs',
  'token.create',
  'token.revoke_own',
  'audit.read',
  'token.revoke_any',
  'session.update',
  'session.share',
  'session.delete',
] as const;
export type Action = (typeof ACTIONS)[number];

export const SESSION_STATES = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
  'deleting',
  'deleted',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const DESIRED_STATES = ['running', 'stopped', 'deleted'] as const;
export type DesiredState = (typeof DESIRED_STATES)[number];

/** Screen sizes of a session. Neko runs all of them at SCREEN_FPS frames per second. */
export const SCREENS = ['1280x720', '1600x900', '1920x1080'] as const;
export type Screen = (typeof SCREENS)[number];
export const DEFAULT_SCREEN: Screen = '1920x1080';
export const SCREEN_FPS = 25;

export const TOKEN_EXPIRY_DAYS = [1, 7, 30, 90, 365] as const;
export type TokenExpiryDays = (typeof TOKEN_EXPIRY_DAYS)[number];
export const DEFAULT_TOKEN_EXPIRY_DAYS: TokenExpiryDays = 30;

export const AUDIT_KINDS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'user.created',
  'user.updated',
  'user.password_reset',
  'session.created',
  'session.updated',
  'session.state',
  'session.started',
  'session.stopped',
  'session.restarted',
  'session.deleted',
  'session.shared',
  'session.unshared',
  'live.opened',
  'token.created',
  'token.revoked',
  'admin.session_access',
  'mcp.connect',
  'mcp.tool_call',
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export const ACTOR_TYPES = ['user', 'token', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const AUDIT_STATUSES = ['pending', 'ok', 'error'] as const;
export type AuditStatus = (typeof AUDIT_STATUSES)[number];

export const AUDIT_PAGE_DEFAULT_LIMIT = 50;
export const AUDIT_PAGE_MAX_LIMIT = 200;

export const SSE_EVENTS = ['session.state', 'session.activity', 'audit'] as const;
export type SseEvent = (typeof SSE_EVENTS)[number];

export const LOG_CONTAINERS = ['neko', 'mcp'] as const;
export type LogContainer = (typeof LOG_CONTAINERS)[number];

export const SESSION_NAME_MAX_LENGTH = 64;
export const ALLOWLIST_MAX_ENTRIES = 100;
