import { eq, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { GlobalRole, SessionState, UserStatus } from '@hydra/shared';
import {
  SESSION_COOKIE,
  toAuthedUser,
  type AuthedUser,
  type PasswordHashing,
} from '../../src/auth/index.js';
import type { Config } from '../../src/config/index.js';
import { newSid, newUlid } from '../../src/crypto/index.js';
import type { Db } from '../../src/db/index.js';
import { sessions, users, type SessionRow } from '../../src/db/schema.js';
import type { Clock } from '../../src/lib/clock.js';
import { apiRequest } from './app.js';

/** 28 characters, not in the common password list. */
export const DEFAULT_PASSWORD = 'correct horse battery staple';

/** Fast stand-in for PasswordHasher in unit tests. Never use it outside tests. */
export const plainHasher: PasswordHashing = {
  hash: (password) => Promise.resolve(`plain:${password}`),
  verify: (phc, password) => Promise.resolve(phc === `plain:${password}`),
  verifyDummy: () => Promise.resolve(false as const),
  needsRehash: (phc) => !phc.startsWith('plain:'),
};

let userCounter = 0;

export async function seedUser(
  deps: { db: Db; clock: Clock; hasher: Pick<PasswordHashing, 'hash'> },
  input: {
    email?: string;
    password?: string;
    role?: GlobalRole;
    status?: UserStatus;
    displayName?: string;
  } = {},
): Promise<{ user: AuthedUser; password: string }> {
  userCounter += 1;
  const password = input.password ?? DEFAULT_PASSWORD;
  const now = deps.clock.now();
  const row = {
    id: newUlid(deps.clock),
    email: (input.email ?? `user${userCounter}@example.com`).trim().toLowerCase(),
    displayName: input.displayName ?? `User ${userCounter}`,
    passwordHash: await deps.hasher.hash(password),
    role: input.role ?? 'member',
    status: input.status ?? 'active',
    mustChangePassword: false,
    failedLogins: 0,
    lockedAt: null,
    lastLoginAt: null,
    passwordChangedAt: now,
    createdAt: now,
    updatedAt: now,
  } satisfies typeof users.$inferInsert;
  deps.db.insert(users).values(row).run();
  return { user: toAuthedUser(row), password };
}

let loginCounter = 0;

/**
 * Logs in through the API and returns the `cookie` header value. Each call uses its own
 * client address (TEST-NET-2), so the login limit per IP does not affect tests that log in often.
 */
export async function loginAs(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<string> {
  loginCounter += 1;
  const response = await apiRequest(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { email, password },
    remoteAddress: `198.51.100.${(loginCounter % 250) + 1}`,
  });
  if (response.statusCode !== 200) {
    throw new Error(`loginAs(${email}) failed: ${response.statusCode} ${response.body}`);
  }
  const cookie = response.cookies.find((item) => item.name === SESSION_COOKIE);
  if (!cookie) throw new Error(`loginAs(${email}): no ${SESSION_COOKIE} cookie`);
  return `${SESSION_COOKIE}=${cookie.value}`;
}

const DESIRED_FOR_STATE: Record<SessionState, SessionRow['desiredState']> = {
  stopped: 'stopped',
  starting: 'running',
  running: 'running',
  stopping: 'stopped',
  error: 'stopped',
  deleting: 'deleted',
  deleted: 'deleted',
};

const HOLDS_PORT: ReadonlySet<SessionState> = new Set(['starting', 'running', 'stopping']);

/** Inserts a session row directly (plan 04 adds the session service). */
export function seedSession(
  deps: { db: Db; clock: Clock; config: Config },
  input: { ownerId: string; name?: string; state?: SessionState },
): SessionRow {
  const state = input.state ?? 'stopped';
  const now = deps.clock.now();
  let mediaPort: number | null = null;
  if (HOLDS_PORT.has(state)) {
    const used = new Set(
      deps.db
        .select({ port: sessions.mediaPort })
        .from(sessions)
        .where(isNotNull(sessions.mediaPort))
        .all()
        .map((row) => row.port),
    );
    const { first, last } = deps.config.mediaPortRange;
    for (let port = first; port <= last && mediaPort === null; port += 1) {
      if (!used.has(port)) mediaPort = port;
    }
  }
  const settings = {
    allowlist: ['example.com'],
    timezone: deps.config.defaultTimezone,
    language: deps.config.defaultLanguage,
    screen: '1920x1080' as const,
  };
  const id = newSid();
  deps.db
    .insert(sessions)
    .values({
      id,
      name: input.name ?? 'Test session',
      ownerId: input.ownerId,
      desiredState: DESIRED_FOR_STATE[state],
      state,
      errorReason: state === 'error' ? 'CrashLoopBackOff: test' : null,
      mediaPort,
      ...settings,
      appliedSettings: settings,
      startedAt: HOLDS_PORT.has(state) ? now : null,
      readyAt: state === 'running' ? now : null,
      createdAt: now,
      updatedAt: now,
      deletedAt: state === 'deleted' ? now : null,
    })
    .run();
  const row = deps.db.select().from(sessions).where(eq(sessions.id, id)).get();
  if (!row) throw new Error('seedSession: the row was not inserted');
  return row;
}
