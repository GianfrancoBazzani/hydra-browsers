import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { CreateTokenRequest, CreateTokenResponse, Token } from '@hydra/shared';
import { authorize, type AccessService, type SessionAccessView } from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { LoginContext } from '../auth/types.js';
import { hmac, newAgentToken, newUlid, type Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { agentTokens, sessions, users } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` and `last_used_ip` are written at most one time per minute (spec section 6.6). */
export const TOKEN_LAST_USED_WRITE_MS = 60_000;

export interface AgentPrincipal {
  tokenId: string;
  userId: string;
  sessionId: string;
}

export interface TokensDeps {
  db: Db;
  clock: Clock;
  subkeys: Subkeys;
  access: Pick<AccessService, 'can'>;
  audit: AuditWriter;
  bus: EventBus;
}

type TokenRow = typeof agentTokens.$inferSelect;

/** Accepts only `Authorization: Bearer hyd_…` (spec section 6.6). The scheme is case-insensitive. */
export function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer +(hyd_[0-9A-Za-z]+) *$/i.exec(authorization);
  return match?.[1] ?? null;
}

function toToken(row: TokenRow, creatorName: string): Token {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdBy: { id: row.createdBy, displayName: creatorName },
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

export class TokensService {
  readonly #deps: TokensDeps;

  constructor(deps: TokensDeps) {
    this.#deps = deps;
  }

  /** The caller checked token.create. The secret is returned one time and never stored. */
  create(context: LoginContext, sessionId: string, input: CreateTokenRequest): CreateTokenResponse {
    const { db, clock, subkeys, audit } = this.#deps;
    // Spec section 7.9: Delete sets desired_state=deleted and revokes all tokens. A session that
    // waits for the reconciler gets no new token.
    if (this.#isDeleting(sessionId))
      throw new HydraError('invalid_state', 'The session is deleting.');
    const { token, prefix } = newAgentToken();
    const now = clock.now();
    const row: TokenRow = {
      id: newUlid(clock),
      sessionId,
      createdBy: context.user.id,
      name: input.name.trim(),
      tokenHmac: hmac(subkeys.agentToken, token),
      prefix,
      createdAt: now,
      expiresAt: now + input.expiresInDays * DAY_MS,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      revokedBy: null,
    };
    db.insert(agentTokens).values(row).run();
    audit.write({
      kind: 'token.created',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { tokenId: row.id, name: row.name, prefix, expiresAt: row.expiresAt },
    });
    return { token: toToken(row, context.user.displayName), secret: token };
  }

  /** All tokens of the session, newest first, revoked and expired ones too. */
  list(sessionId: string): Token[] {
    return this.#deps.db
      .select({ token: agentTokens, creatorName: users.displayName })
      .from(agentTokens)
      .innerJoin(users, eq(users.id, agentTokens.createdBy))
      .where(eq(agentTokens.sessionId, sessionId))
      .orderBy(desc(agentTokens.createdAt), desc(agentTokens.id))
      .all()
      .map((row) => toToken(row.token, row.creatorName));
  }

  /** Writes token.revoked and publishes token.revoked. A revoked token stays revoked (no-op). */
  revoke(actor: LoginContext | 'system', tokenId: string): void {
    const { db, clock, audit, bus } = this.#deps;
    const row = db.select().from(agentTokens).where(eq(agentTokens.id, tokenId)).get();
    if (!row) throw new HydraError('not_found', 'Token not found.');
    const actorId = actor === 'system' ? null : actor.user.id;
    const changed = db
      .update(agentTokens)
      .set({ revokedAt: clock.now(), revokedBy: actorId })
      .where(and(eq(agentTokens.id, tokenId), isNull(agentTokens.revokedAt)))
      .run().changes;
    if (changed === 0) return;
    audit.write({
      kind: 'token.revoked',
      actorType: actor === 'system' ? 'system' : 'user',
      actorId,
      sessionId: row.sessionId,
      data: { tokenId, name: row.name, prefix: row.prefix },
    });
    bus.publish({ type: 'token.revoked', tokenId, sessionId: row.sessionId });
  }

  /**
   * DELETE /api/sessions/:sid/tokens/:tokenId. The caller checked token.revoke_own with
   * `requireSession`. A token of another user also needs token.revoke_any.
   */
  revokeInSession(context: LoginContext, view: SessionAccessView, tokenId: string): void {
    const row = this.#deps.db
      .select({ createdBy: agentTokens.createdBy })
      .from(agentTokens)
      .where(and(eq(agentTokens.id, tokenId), eq(agentTokens.sessionId, view.id)))
      .get();
    if (!row) throw new HydraError('not_found', 'Token not found.');
    if (row.createdBy !== context.user.id && !authorize(context.user, view, 'token.revoke_any')) {
      throw new HydraError('forbidden', 'Only the owner can revoke the tokens of other users.');
    }
    this.revoke(context, tokenId);
  }

  revokeAllForSession(sessionId: string): void {
    for (const id of this.#activeIds(eq(agentTokens.sessionId, sessionId)))
      this.revoke('system', id);
  }

  revokeAllCreatedBy(userId: string): void {
    for (const id of this.#activeIds(eq(agentTokens.createdBy, userId))) this.revoke('system', id);
  }

  /** The three conditions of spec section 6.6. */
  isValid(tokenId: string): boolean {
    const row = this.#deps.db.select().from(agentTokens).where(eq(agentTokens.id, tokenId)).get();
    return row !== undefined && this.#valid(row, this.#deps.clock.now());
  }

  /** Bearer check of the MCP endpoint. Null if the token is missing, not valid, or for another session. */
  resolve(authorization: string | undefined, sessionId: string, ip: string): AgentPrincipal | null {
    const { db, clock, subkeys } = this.#deps;
    const token = parseBearer(authorization);
    if (token === null) return null;
    const row = db
      .select()
      .from(agentTokens)
      .where(eq(agentTokens.tokenHmac, hmac(subkeys.agentToken, token)))
      .get();
    if (!row || row.sessionId !== sessionId) return null;
    const now = clock.now();
    if (!this.#valid(row, now)) return null;
    if (row.lastUsedAt === null || now - row.lastUsedAt >= TOKEN_LAST_USED_WRITE_MS) {
      db.update(agentTokens)
        .set({ lastUsedAt: now, lastUsedIp: ip })
        .where(eq(agentTokens.id, row.id))
        .run();
    }
    return { tokenId: row.id, userId: row.createdBy, sessionId: row.sessionId };
  }

  /** After Delete the row keeps its state and `deleted_at` until the reconciler is done. */
  #isDeleting(sessionId: string): boolean {
    const session = this.#deps.db
      .select({ desiredState: sessions.desiredState })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return session?.desiredState === 'deleted';
  }

  #valid(row: TokenRow, now: number): boolean {
    return (
      row.revokedAt === null &&
      row.expiresAt > now &&
      !this.#isDeleting(row.sessionId) &&
      this.#deps.access.can(row.createdBy, row.sessionId, 'token.create')
    );
  }

  #activeIds(where: SQL): string[] {
    return this.#deps.db
      .select({ id: agentTokens.id })
      .from(agentTokens)
      .where(and(where, isNull(agentTokens.revokedAt)))
      .all()
      .map((row) => row.id);
  }
}
