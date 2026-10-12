// The vault of each session (spec section 6.9): credentials, reveal, agent fill values, redaction sets.
import { asc, count, eq, and } from 'drizzle-orm';
import {
  VAULT_FIELDS,
  VAULT_MAX_CREDENTIALS,
  VAULT_REDACT_MIN_CHARS,
  VAULT_TEXTS,
  createRedactor,
  vaultLabel,
  type CreateCredentialRequest,
  type Credential,
  type RedactionEntry,
  type Redactor,
  type RevealField,
  type RevealResponse,
  type TotpParams,
  type UpdateCredentialRequest,
  type VaultField,
  type VaultSiteMatch,
} from '@hydra/shared';
import type { AuditWriter } from '../audit/index.js';
import type { LoginContext } from '../auth/types.js';
import type { Config } from '../config/index.js';
import { newUlid, type Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import { sessions, users, vaultCredentials, type VaultCredentialRow } from '../db/schema.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { decryptValue, encryptValue } from './crypto.js';
import { siteMatchOf, websitePermitted } from './site.js';
import { totpAt, totpForFill } from './totp.js';

/** Spec section 8.9: a redaction set that nobody used for 10 min is removed. */
export const REDACTION_CACHE_IDLE_MS = 10 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** TOTP periods are 30 or 60 s, so the codes of the redaction set change at most each 30 s. */
const TOTP_BUCKET_MS = 30_000;
const HTTP_NOT_PERMITTED =
  'http is permitted only for the hosts in HYDRA_VAULT_HTTP_HOSTS. Use https.';
const KEEP_ONE_VALUE = 'Keep a username, a password, or a two-factor secret.';

export interface VaultDeps {
  db: Db;
  clock: Clock;
  subkeys: Pick<Subkeys, 'vault'>;
  config: Pick<Config, 'vaultHttpHosts'>;
  audit: AuditWriter;
  bus: EventBus;
}

export interface FillValue {
  value: string;
  match: VaultSiteMatch;
  /** Time to wait before the fill (spec section 6.9.4). */
  waitMs: number;
}

export type FillLookup = { ok: true; fill: FillValue } | { ok: false; message: string };

interface CacheEntry {
  fixed: RedactionEntry[];
  totp: Array<{ credentialId: string; params: TotpParams }>;
  lastUsed: number;
  redactor: Redactor | null;
  bucket: number;
}

/** The column of the encrypted value of each field. */
const ENCRYPTED = {
  username: 'usernameEnc',
  password: 'passwordEnc',
  totp: 'totpEnc',
} as const satisfies Record<VaultField, keyof VaultCredentialRow>;

function valuesOf(
  row: Pick<VaultCredentialRow, 'usernameEnc' | 'passwordEnc' | 'totpEnc'>,
): VaultField[] {
  return VAULT_FIELDS.filter((field) => row[ENCRYPTED[field]] !== null);
}

export class VaultService {
  readonly #deps: VaultDeps;
  readonly #cache = new Map<string, CacheEntry>();
  #timer: NodeJS.Timeout | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(deps: VaultDeps) {
    this.#deps = deps;
  }

  /** Drops the redaction set of a session that stops (spec section 8.9), and starts the idle sweep. */
  start(): void {
    this.#unsubscribe = this.#deps.bus.subscribe('session.state', (event) => {
      if (event.state !== 'starting' && event.state !== 'running')
        this.#cache.delete(event.sessionId);
    });
    this.#timer = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#cache.clear();
  }

  /** Removes the redaction sets that nobody used for REDACTION_CACHE_IDLE_MS. */
  sweep(): void {
    const now = this.#deps.clock.now();
    for (const [sessionId, entry] of this.#cache) {
      if (now - entry.lastUsed >= REDACTION_CACHE_IDLE_MS) this.#cache.delete(sessionId);
    }
  }

  list(sessionId: string): Credential[] {
    return this.#deps.db
      .select({ row: vaultCredentials, creatorName: users.displayName })
      .from(vaultCredentials)
      .innerJoin(users, eq(users.id, vaultCredentials.createdBy))
      .where(eq(vaultCredentials.sessionId, sessionId))
      .orderBy(asc(vaultCredentials.createdAt), asc(vaultCredentials.id))
      .all()
      .map(({ row, creatorName }) => this.#toCredential(row, creatorName));
  }

  /** The caller checked vault.manage. */
  create(context: LoginContext, sessionId: string, input: CreateCredentialRequest): Credential {
    const { db, clock, audit } = this.#deps;
    this.#requireNotDeleting(sessionId);
    this.#requirePermitted(input.website);
    const id = newUlid(clock);
    const now = clock.now();
    const row: VaultCredentialRow = {
      id,
      sessionId,
      name: input.name,
      website: input.website,
      usernameEnc: this.#encrypt(sessionId, id, 'username', input.username),
      passwordEnc: this.#encrypt(sessionId, id, 'password', input.password),
      totpEnc: this.#encrypt(sessionId, id, 'totp', input.totp && JSON.stringify(input.totp)),
      createdBy: context.user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.transaction(
      (tx) => {
        const existing =
          tx
            .select({ n: count() })
            .from(vaultCredentials)
            .where(eq(vaultCredentials.sessionId, sessionId))
            .get()?.n ?? 0;
        if (existing >= VAULT_MAX_CREDENTIALS) {
          throw new HydraError(
            'vault_limit_reached',
            `The vault has ${String(VAULT_MAX_CREDENTIALS)} credentials. Delete one first.`,
          );
        }
        tx.insert(vaultCredentials).values(row).run();
      },
      { behavior: 'immediate' },
    );
    this.#cache.delete(sessionId);
    audit.write({
      kind: 'vault.created',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { credentialId: id, name: row.name, website: row.website, values: valuesOf(row) },
    });
    return this.#toCredential(row, context.user.displayName);
  }

  /** The caller checked vault.manage. A missing key keeps the value, null removes it. */
  update(
    context: LoginContext,
    sessionId: string,
    credentialId: string,
    input: UpdateCredentialRequest,
  ): Credential {
    const { db, clock, audit } = this.#deps;
    this.#requireNotDeleting(sessionId);
    const row = this.#row(sessionId, credentialId);
    const next: VaultCredentialRow = { ...row };
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== row.name) {
      next.name = input.name;
      changed.push('name');
    }
    if (input.website !== undefined && input.website !== row.website) {
      this.#requirePermitted(input.website);
      next.website = input.website;
      changed.push('website');
    }
    const secret = (
      field: VaultField,
      value: string | null | undefined,
      current: Buffer | null,
    ): Buffer | null => {
      if (value === undefined || (value === null && current === null)) return current;
      changed.push(field);
      return value === null ? null : this.#encrypt(sessionId, credentialId, field, value);
    };
    next.usernameEnc = secret('username', input.username, row.usernameEnc);
    next.passwordEnc = secret('password', input.password, row.passwordEnc);
    next.totpEnc = secret('totp', input.totp && JSON.stringify(input.totp), row.totpEnc);
    const creatorName = this.#creatorName(row.createdBy);
    if (changed.length === 0) return this.#toCredential(row, creatorName);
    if (valuesOf(next).length === 0)
      throw new HydraError('validation_failed', KEEP_ONE_VALUE, { username: KEEP_ONE_VALUE });
    next.updatedAt = clock.now();
    db.update(vaultCredentials)
      .set({
        name: next.name,
        website: next.website,
        usernameEnc: next.usernameEnc,
        passwordEnc: next.passwordEnc,
        totpEnc: next.totpEnc,
        updatedAt: next.updatedAt,
      })
      .where(eq(vaultCredentials.id, credentialId))
      .run();
    this.#cache.delete(sessionId);
    audit.write({
      kind: 'vault.updated',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { credentialId, name: next.name, changed },
    });
    return this.#toCredential(next, creatorName);
  }

  /** The caller checked vault.manage. */
  remove(context: LoginContext, sessionId: string, credentialId: string): void {
    const row = this.#row(sessionId, credentialId);
    this.#deps.db.delete(vaultCredentials).where(eq(vaultCredentials.id, credentialId)).run();
    this.#cache.delete(sessionId);
    this.#deps.audit.write({
      kind: 'vault.deleted',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { credentialId, name: row.name },
    });
  }

  /** The caller checked vault.reveal. One value for each call, and one audit event (spec section 6.9.5). */
  reveal(
    context: LoginContext,
    sessionId: string,
    credentialId: string,
    field: RevealField,
  ): RevealResponse {
    const row = this.#row(sessionId, credentialId);
    let response: RevealResponse;
    if (field === 'password') {
      if (row.passwordEnc === null)
        throw new HydraError('not_found', 'The credential has no password.');
      response = { field, value: this.#decrypt(row, 'password', row.passwordEnc) };
    } else {
      if (row.totpEnc === null)
        throw new HydraError('not_found', 'The credential has no two-factor secret.');
      const params = this.#totpParams(row, row.totpEnc);
      const code = totpAt(params, this.#deps.clock.now());
      response = { field, code: code.code, validUntil: code.validUntil, period: params.period };
    }
    this.#deps.audit.write({
      kind: 'vault.revealed',
      actorType: 'user',
      actorId: context.user.id,
      sessionId,
      data: { credentialId, name: row.name, field },
    });
    return response;
  }

  /** The result text of vault_list (spec section 8.8.2 step 2). No values. */
  agentList(sessionId: string): string {
    const rows = this.#rows(sessionId);
    if (rows.length === 0) return VAULT_TEXTS.emptyVault;
    return rows
      .map(
        (row) => `- ${row.id} · ${row.name} · ${row.website} · values: ${valuesOf(row).join(', ')}`,
      )
      .join('\n');
  }

  /** The value of a fill (spec section 8.8.2 step 4). Throws VaultDecryptError if the value cannot be decrypted. */
  fillValue(sessionId: string, credentialId: string, field: VaultField): FillLookup {
    const row = this.#find(sessionId, credentialId);
    if (!row)
      return {
        ok: false,
        message: `Credential ${credentialId} does not exist in this session. Call vault_list.`,
      };
    if (!websitePermitted(row.website, this.#deps.config.vaultHttpHosts)) {
      return {
        ok: false,
        message: `Credential ${credentialId} uses http, and http is not permitted for ${new URL(row.website).hostname}.`,
      };
    }
    const match = siteMatchOf(row.website);
    const blob = row[ENCRYPTED[field]];
    if (blob === null) return { ok: false, message: `Credential ${credentialId} has no ${field}.` };
    if (field === 'totp') {
      const { code, waitMs } = totpForFill(this.#totpParams(row, blob), this.#deps.clock.now());
      return { ok: true, fill: { value: code, match, waitMs } };
    }
    return { ok: true, fill: { value: this.#decrypt(row, field, blob), match, waitMs: 0 } };
  }

  /** The redaction set of a session (spec section 8.9). Throws VaultDecryptError if a value cannot be decrypted. */
  redactor(sessionId: string): Redactor {
    const now = this.#deps.clock.now();
    let entry = this.#cache.get(sessionId);
    if (entry === undefined) {
      entry = this.#build(sessionId);
      this.#cache.set(sessionId, entry);
    }
    entry.lastUsed = now;
    const bucket = entry.totp.length === 0 ? 0 : Math.floor(now / TOTP_BUCKET_MS);
    if (entry.redactor === null || entry.bucket !== bucket) {
      const codes: RedactionEntry[] = [];
      for (const { credentialId, params } of entry.totp) {
        const periodMs = params.period * 1000;
        for (const offset of [-1, 0, 1]) {
          codes.push({
            value: totpAt(params, now + offset * periodMs).code,
            label: vaultLabel(credentialId, 'totp'),
          });
        }
      }
      entry.redactor = createRedactor([...entry.fixed, ...codes]);
      entry.bucket = bucket;
    }
    return entry.redactor;
  }

  #build(sessionId: string): CacheEntry {
    const rows = this.#rows(sessionId);
    const fixed: RedactionEntry[] = [];
    const totp: CacheEntry['totp'] = [];
    for (const row of rows) {
      for (const field of ['username', 'password'] as const) {
        const blob = row[ENCRYPTED[field]];
        if (blob === null) continue;
        const value = this.#decrypt(row, field, blob);
        if (Array.from(value).length >= VAULT_REDACT_MIN_CHARS)
          fixed.push({ value, label: vaultLabel(row.id, field) });
      }
      if (row.totpEnc !== null)
        totp.push({ credentialId: row.id, params: this.#totpParams(row, row.totpEnc) });
    }
    return { fixed, totp, lastUsed: 0, redactor: null, bucket: 0 };
  }

  #encrypt(
    sessionId: string,
    credentialId: string,
    field: VaultField,
    value: string | undefined,
  ): Buffer | null {
    if (value === undefined) return null;
    return encryptValue(this.#deps.subkeys.vault, { sessionId, credentialId, field }, value);
  }

  #decrypt(row: VaultCredentialRow, field: VaultField, blob: Buffer): string {
    return decryptValue(
      this.#deps.subkeys.vault,
      { sessionId: row.sessionId, credentialId: row.id, field },
      blob,
    );
  }

  #totpParams(row: VaultCredentialRow, blob: Buffer): TotpParams {
    return JSON.parse(this.#decrypt(row, 'totp', blob)) as TotpParams;
  }

  #rows(sessionId: string): VaultCredentialRow[] {
    return this.#deps.db
      .select()
      .from(vaultCredentials)
      .where(eq(vaultCredentials.sessionId, sessionId))
      .orderBy(asc(vaultCredentials.createdAt), asc(vaultCredentials.id))
      .all();
  }

  #find(sessionId: string, credentialId: string): VaultCredentialRow | undefined {
    return this.#deps.db
      .select()
      .from(vaultCredentials)
      .where(and(eq(vaultCredentials.id, credentialId), eq(vaultCredentials.sessionId, sessionId)))
      .get();
  }

  #row(sessionId: string, credentialId: string): VaultCredentialRow {
    const row = this.#find(sessionId, credentialId);
    if (!row) throw new HydraError('not_found', 'Credential not found.');
    return row;
  }

  #creatorName(userId: string): string {
    return (
      this.#deps.db
        .select({ name: users.displayName })
        .from(users)
        .where(eq(users.id, userId))
        .get()?.name ?? ''
    );
  }

  #requireNotDeleting(sessionId: string): void {
    const session = this.#deps.db
      .select({ desiredState: sessions.desiredState })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (session?.desiredState === 'deleted')
      throw new HydraError('invalid_state', 'The session is deleting.');
  }

  #requirePermitted(website: string): void {
    if (!websitePermitted(website, this.#deps.config.vaultHttpHosts)) {
      throw new HydraError('validation_failed', HTTP_NOT_PERMITTED, {
        website: HTTP_NOT_PERMITTED,
      });
    }
  }

  #toCredential(row: VaultCredentialRow, creatorName: string): Credential {
    const match = siteMatchOf(row.website);
    return {
      id: row.id,
      name: row.name,
      website: row.website,
      matchDomain: match.matchDomain,
      matchSubdomains: match.matchSubdomains,
      username: row.usernameEnc === null ? null : this.#decrypt(row, 'username', row.usernameEnc),
      hasPassword: row.passwordEnc !== null,
      hasTotp: row.totpEnc !== null,
      createdBy: { id: row.createdBy, displayName: creatorName },
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
