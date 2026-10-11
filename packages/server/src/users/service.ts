import { asc, eq } from 'drizzle-orm';
import type {
  CreateUserRequest,
  CreateUserResponse,
  GlobalRole,
  ResetPasswordResponse,
  UpdateUserRequest,
  UserSummary,
} from '@hydra/shared';
import type { AuditInput, AuditWriter } from '../audit/index.js';
import {
  checkPasswordRules,
  generateOneTimePassword,
  normalizeEmail,
  type AuthService,
  type LoginContext,
  type PasswordHashing,
} from '../auth/index.js';
import { newUlid } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

/** The part of TokensService that a disable needs. Structural, so users/ does not import tokens/. */
export interface TokenRevoker {
  revokeAllCreatedBy(userId: string): void;
}

export interface UsersDeps {
  db: Db;
  clock: Clock;
  hasher: Pick<PasswordHashing, 'hash'>;
  auth: Pick<AuthService, 'endLoginSessions'>;
  tokens: TokenRevoker;
  audit: AuditWriter;
  bus: EventBus;
}

type UserRow = typeof users.$inferSelect;
type Actor = Pick<AuditInput, 'actorType' | 'actorId'>;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;
const DISPLAY_NAME_MAX = 64;

/** The email rule of the service and of the CLI. `email` must be normalized. */
export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export function toUserSummary(row: UserRow): UserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    status: row.status,
    locked: row.lockedAt !== null,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt,
  };
}

function userActor(context: LoginContext): Actor {
  return { actorType: 'user', actorId: context.user.id };
}

const SYSTEM: Actor = { actorType: 'system', actorId: null };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

export class UsersService {
  readonly #deps: UsersDeps;

  constructor(deps: UsersDeps) {
    this.#deps = deps;
  }

  list(): UserSummary[] {
    return this.#deps.db.select().from(users).orderBy(asc(users.email)).all().map(toUserSummary);
  }

  /** Admin action: the gateway generates a one-time password and shows it one time. */
  async create(actor: LoginContext, input: CreateUserRequest): Promise<CreateUserResponse> {
    const oneTimePassword = generateOneTimePassword();
    const user = await this.#insert(
      { ...input, password: oneTimePassword, mustChangePassword: true },
      userActor(actor),
    );
    return { user, oneTimePassword };
  }

  /** `hydra user create`: the operator types the password. */
  async createWithPassword(input: {
    email: string;
    displayName: string;
    role: GlobalRole;
    password: string;
  }): Promise<UserSummary> {
    checkPasswordRules(input.password, input.email);
    return this.#insert({ ...input, mustChangePassword: false }, SYSTEM);
  }

  /** A role change or a disable publishes rights.changed. A disable also ends the login sessions and revokes the tokens. */
  update(actor: LoginContext, userId: string, input: UpdateUserRequest): UserSummary {
    const { db, clock, auth, tokens, audit, bus } = this.#deps;
    const row = this.#find(userId);
    const roleChanges = input.role !== undefined && input.role !== row.role;
    const statusChanges = input.status !== undefined && input.status !== row.status;
    if (userId === actor.user.id && (roleChanges || statusChanges)) {
      throw new HydraError('conflict', 'You cannot change your own role or status.');
    }
    const patch: Partial<Pick<UserRow, 'displayName' | 'role' | 'status'>> = {};
    const changes: Record<string, { from: string; to: string }> = {};
    const displayName = input.displayName?.trim();
    if (displayName !== undefined && displayName !== row.displayName) {
      if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
        throw new HydraError('validation_failed', 'The request is not valid.', {
          displayName: `Use 1 to ${DISPLAY_NAME_MAX} characters.`,
        });
      }
      patch.displayName = displayName;
      changes.displayName = { from: row.displayName, to: displayName };
    }
    if (input.role !== undefined && roleChanges) {
      patch.role = input.role;
      changes.role = { from: row.role, to: input.role };
    }
    if (input.status !== undefined && statusChanges) {
      patch.status = input.status;
      changes.status = { from: row.status, to: input.status };
    }
    if (Object.keys(changes).length === 0) return toUserSummary(row);
    const updated = db
      .update(users)
      .set({ ...patch, updatedAt: clock.now() })
      .where(eq(users.id, userId))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    if (patch.status === 'disabled') {
      auth.endLoginSessions(userId);
      tokens.revokeAllCreatedBy(userId);
    }
    audit.write({
      ...userActor(actor),
      kind: 'user.updated',
      sessionId: null,
      data: { userId, changes },
    });
    if (patch.role !== undefined || patch.status === 'disabled') {
      bus.publish({ type: 'rights.changed', userId });
    }
    return toUserSummary(updated);
  }

  /** Admin action: new one-time password. Ends all login sessions of the user and the lock. */
  async resetPassword(actor: LoginContext, userId: string): Promise<ResetPasswordResponse> {
    const row = this.#find(userId);
    const oneTimePassword = generateOneTimePassword();
    await this.#setPassword(row, oneTimePassword, true, userActor(actor));
    return { oneTimePassword };
  }

  /** `hydra user reset-password`: the operator types the new password. */
  async setPassword(email: string, password: string): Promise<UserSummary> {
    const row = this.#deps.db
      .select()
      .from(users)
      .where(eq(users.email, normalizeEmail(email)))
      .get();
    if (!row) throw new HydraError('not_found', 'No user has this email.');
    checkPasswordRules(password, row.email);
    return this.#setPassword(row, password, false, SYSTEM);
  }

  unlock(actor: LoginContext, userId: string): UserSummary {
    const { db, clock, audit } = this.#deps;
    this.#find(userId);
    const updated = db
      .update(users)
      .set({ lockedAt: null, failedLogins: 0, updatedAt: clock.now() })
      .where(eq(users.id, userId))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    audit.write({
      ...userActor(actor),
      kind: 'user.updated',
      sessionId: null,
      data: { userId, unlocked: true },
    });
    return toUserSummary(updated);
  }

  #find(userId: string): UserRow {
    const row = this.#deps.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) throw new HydraError('not_found', 'User not found.');
    return row;
  }

  async #insert(
    input: {
      email: string;
      displayName: string;
      role: GlobalRole;
      password: string;
      mustChangePassword: boolean;
    },
    actor: Actor,
  ): Promise<UserSummary> {
    const { db, clock, hasher, audit } = this.#deps;
    const email = normalizeEmail(input.email);
    const displayName = input.displayName.trim();
    if (!isValidEmail(email)) {
      throw new HydraError('validation_failed', 'The request is not valid.', {
        email: 'Enter an email address.',
      });
    }
    if (displayName.length === 0 || displayName.length > DISPLAY_NAME_MAX) {
      throw new HydraError('validation_failed', 'The request is not valid.', {
        displayName: `Use 1 to ${DISPLAY_NAME_MAX} characters.`,
      });
    }
    const exists = () =>
      db.select({ id: users.id }).from(users).where(eq(users.email, email)).get();
    if (exists()) throw new HydraError('conflict', 'A user with this email exists.');
    const passwordHash = await hasher.hash(input.password);
    const now = clock.now();
    const row: UserRow = {
      id: newUlid(clock),
      email,
      displayName,
      passwordHash,
      role: input.role,
      status: 'active',
      mustChangePassword: input.mustChangePassword,
      failedLogins: 0,
      lockedAt: null,
      lastLoginAt: null,
      passwordChangedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    try {
      db.insert(users).values(row).run();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HydraError('conflict', 'A user with this email exists.');
      }
      throw error;
    }
    audit.write({
      ...actor,
      kind: 'user.created',
      sessionId: null,
      data: { userId: row.id, email, role: row.role },
    });
    return toUserSummary(row);
  }

  async #setPassword(
    row: UserRow,
    password: string,
    mustChangePassword: boolean,
    actor: Actor,
  ): Promise<UserSummary> {
    const { db, clock, hasher, auth, audit } = this.#deps;
    const passwordHash = await hasher.hash(password);
    const now = clock.now();
    const updated = db
      .update(users)
      .set({
        passwordHash,
        mustChangePassword,
        failedLogins: 0,
        lockedAt: null,
        passwordChangedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, row.id))
      .returning()
      .get();
    if (!updated) throw new HydraError('not_found', 'User not found.');
    auth.endLoginSessions(row.id);
    audit.write({
      ...actor,
      kind: 'user.password_reset',
      sessionId: null,
      data: { userId: row.id },
    });
    return toUserSummary(updated);
  }
}
