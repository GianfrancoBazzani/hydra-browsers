// Database schema of spec section 13.1. Times are integers (ms since the epoch).
// Only type imports from @hydra/shared: drizzle-kit loads this file without the @hydra/source
// condition, so a value import would need the built dist of @hydra/shared.
import { sql } from 'drizzle-orm';
import {
  blob,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type {
  ActorType,
  AuditKind,
  AuditStatus,
  DesiredState,
  GlobalRole,
  MemberRole,
  NekoProfile,
  Screen,
  SessionSettings,
  SessionState,
  UserStatus,
} from '@hydra/shared';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** Lowercase. */
  email: text('email').notNull().unique(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<GlobalRole>().notNull(),
  status: text('status').$type<UserStatus>().notNull(),
  mustChangePassword: integer('must_change_password', { mode: 'boolean' }).notNull(),
  /** Failures in a row (spec section 6.4). */
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedAt: integer('locked_at'),
  lastLoginAt: integer('last_login_at'),
  passwordChangedAt: integer('password_changed_at').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const loginSessions = sqliteTable('login_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** HMAC-SHA256 (subkey login-session) of the cookie value. */
  tokenHmac: blob('token_hmac', { mode: 'buffer' }).notNull().unique(),
  ip: text('ip').notNull(),
  userAgent: text('user_agent').notNull(),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    /** The sid (spec section 7.1). */
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id),
    desiredState: text('desired_state').$type<DesiredState>().notNull(),
    state: text('state').$type<SessionState>().notNull(),
    errorReason: text('error_reason'),
    /** Not null only while the session holds a media port (spec section 7.8). */
    mediaPort: integer('media_port'),
    allowlist: text('allowlist', { mode: 'json' }).$type<string[]>().notNull(),
    timezone: text('timezone').notNull(),
    language: text('language').notNull(),
    screen: text('screen').$type<Screen>().notNull(),
    /** The settings of the last Start or Restart (spec section 7.2). */
    appliedSettings: text('applied_settings', { mode: 'json' }).$type<SessionSettings>().notNull(),
    startedAt: integer('started_at'),
    readyAt: integer('ready_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (table) => [
    uniqueIndex('sessions_media_port_unique')
      .on(table.mediaPort)
      .where(sql`${table.mediaPort} IS NOT NULL`),
  ],
);

export const sessionMembers = sqliteTable(
  'session_members',
  {
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    role: text('role').$type<MemberRole>().notNull(),
    grantedBy: text('granted_by')
      .notNull()
      .references(() => users.id),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.userId] })],
);

export const agentTokens = sqliteTable('agent_tokens', {
  id: text('id').primaryKey(),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  createdBy: text('created_by')
    .notNull()
    .references(() => users.id),
  name: text('name').notNull(),
  /** HMAC-SHA256 (subkey agent-token) of the token. */
  tokenHmac: blob('token_hmac', { mode: 'buffer' }).notNull().unique(),
  /** `hyd_` + the first 8 characters + `…`. */
  prefix: text('prefix').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastUsedAt: integer('last_used_at'),
  lastUsedIp: text('last_used_ip'),
  revokedAt: integer('revoked_at'),
  revokedBy: text('revoked_by').references(() => users.id),
});

export const liveGrants = sqliteTable('live_grants', {
  id: text('id').primaryKey(),
  loginSessionId: text('login_session_id')
    .notNull()
    .references(() => loginSessions.id, { onDelete: 'cascade' }),
  userId: text('user_id')
    .notNull()
    .references(() => users.id),
  sessionId: text('session_id')
    .notNull()
    .references(() => sessions.id),
  nekoProfile: text('neko_profile').$type<NekoProfile>().notNull(),
  /** HMAC-SHA256 (subkey live-grant) of the cookie value. */
  cookieHmac: blob('cookie_hmac', { mode: 'buffer' }).notNull().unique(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

export const auditEvents = sqliteTable(
  'audit_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ts: integer('ts').notNull(),
    kind: text('kind').$type<AuditKind>().notNull(),
    actorType: text('actor_type').$type<ActorType>().notNull(),
    actorId: text('actor_id'),
    sessionId: text('session_id'),
    status: text('status').$type<AuditStatus>(),
    data: text('data', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (table) => [
    index('audit_events_session_ts_idx').on(table.sessionId, table.ts),
    index('audit_events_kind_ts_idx').on(table.kind, table.ts),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type LoginSessionRow = typeof loginSessions.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionMemberRow = typeof sessionMembers.$inferSelect;
export type AgentTokenRow = typeof agentTokens.$inferSelect;
export type LiveGrantRow = typeof liveGrants.$inferSelect;
export type AuditEventRow = typeof auditEvents.$inferSelect;
