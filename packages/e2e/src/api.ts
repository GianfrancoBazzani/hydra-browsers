import { setTimeout as sleep } from 'node:timers/promises';
import { request, type APIRequestContext } from '@playwright/test';
import type {
  AuditPage,
  AuditQuery,
  CreateSessionRequest,
  CreateTokenResponse,
  CreateUserResponse,
  Me,
  Member,
  MemberRole,
  SessionResource,
  SessionState,
} from '@hydra/shared';
import { E2E } from './env.js';

export type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface ApiResult {
  status: number;
  text: string;
  json: unknown;
}

/** The error code of an API error body (spec section 12.2), or null. */
export function errorCode(json: unknown): string | null {
  if (typeof json === 'object' && json !== null && 'error' in json) {
    const error = json.error;
    if (typeof error === 'object' && error !== null && 'code' in error) {
      return typeof error.code === 'string' ? error.code : null;
    }
  }
  return null;
}

/** Dashboard API client of one user. It keeps the login session cookie like the browser does. */
export class HydraApi {
  readonly request: APIRequestContext;

  constructor(context: APIRequestContext) {
    this.request = context;
  }

  /** The Origin header passes the CSRF check of spec section 6.4. */
  static async create(storageState?: string): Promise<HydraApi> {
    const context = await request.newContext({
      baseURL: E2E.publicUrl,
      extraHTTPHeaders: { origin: new URL(E2E.publicUrl).origin },
      ...(storageState === undefined ? {} : { storageState }),
    });
    return new HydraApi(context);
  }

  static async login(email: string, password: string): Promise<HydraApi> {
    const api = await HydraApi.create();
    await api.ok('POST', '/api/auth/login', { email, password });
    return api;
  }

  /** Any request. A request that is not GET always has a JSON body (`{}` if there is no data). */
  async call(
    method: Method,
    path: string,
    data?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<ApiResult> {
    const response = await this.request.fetch(path, {
      method,
      ...(method === 'GET' ? {} : { data: data ?? {} }),
      ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
    });
    const text = await response.text();
    let json: unknown = null;
    if (text !== '') {
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        json = null;
      }
    }
    return { status: response.status(), text, json };
  }

  /** A request that must succeed (2xx). Returns the parsed body. */
  async ok<T>(method: Method, path: string, data?: unknown): Promise<T> {
    const result = await this.call(method, path, data);
    if (result.status < 200 || result.status > 299) {
      throw new Error(`${method} ${path} returned ${result.status}: ${result.text}`);
    }
    return result.json as T;
  }

  me(): Promise<Me> {
    return this.ok<Me>('GET', '/api/auth/me');
  }

  async changePassword(current: string, next: string): Promise<void> {
    await this.ok('POST', '/api/auth/password', { current, new: next });
  }

  createMember(email: string, displayName: string): Promise<CreateUserResponse> {
    return this.ok<CreateUserResponse>('POST', '/api/users', {
      email,
      displayName,
      role: 'member',
    });
  }

  createSession(input: CreateSessionRequest): Promise<SessionResource> {
    return this.ok<SessionResource>('POST', '/api/sessions', input);
  }

  getSession(sid: string): Promise<SessionResource> {
    return this.ok<SessionResource>('GET', `/api/sessions/${sid}`);
  }

  async listSessions(all: boolean): Promise<SessionResource[]> {
    const body = await this.ok<unknown>('GET', all ? '/api/sessions?all=1' : '/api/sessions');
    // The index does not fix the list wrapper (Index issues): accept an array or { sessions }.
    const list = Array.isArray(body) ? body : (body as { sessions?: unknown }).sessions;
    if (!Array.isArray(list)) {
      throw new Error(`GET /api/sessions returned no list: ${JSON.stringify(body)}`);
    }
    return list as SessionResource[];
  }

  startSession(sid: string): Promise<SessionResource> {
    return this.ok<SessionResource>('POST', `/api/sessions/${sid}/start`);
  }

  async deleteSession(sid: string, confirmName: string): Promise<void> {
    await this.ok('POST', `/api/sessions/${sid}/delete`, { confirmName });
  }

  /** Polls GET /api/sessions/:sid every second. Fails at once on the state "error". */
  async waitForState(
    sid: string,
    state: SessionState,
    timeoutMs: number,
  ): Promise<{ session: SessionResource; elapsedMs: number }> {
    const started = Date.now();
    for (;;) {
      const session = await this.getSession(sid);
      const elapsedMs = Date.now() - started;
      if (session.state === state) {
        return { session, elapsedMs };
      }
      if (session.state === 'error') {
        throw new Error(`Session ${sid} is in the state error: ${session.errorReason ?? ''}`);
      }
      if (elapsedMs > timeoutMs) {
        throw new Error(`Session ${sid} is ${session.state}, not ${state}, after ${timeoutMs} ms`);
      }
      await sleep(1_000);
    }
  }

  /** Polls until GET /api/sessions/:sid returns 404. */
  async waitForGone(sid: string, timeoutMs: number): Promise<void> {
    const started = Date.now();
    for (;;) {
      const result = await this.call('GET', `/api/sessions/${sid}`);
      if (result.status === 404) {
        return;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`Session ${sid} still exists after ${timeoutMs} ms: ${result.text}`);
      }
      await sleep(1_000);
    }
  }

  createToken(sid: string, name: string): Promise<CreateTokenResponse> {
    return this.ok<CreateTokenResponse>('POST', `/api/sessions/${sid}/tokens`, {
      name,
      expiresInDays: 1,
    });
  }

  async revokeToken(sid: string, tokenId: string): Promise<void> {
    await this.ok('DELETE', `/api/sessions/${sid}/tokens/${tokenId}`);
  }

  /** POST /api/sessions/:sid/vault (spec section 12.1). */
  async createCredential(sid: string, body: Record<string, unknown>): Promise<{ id: string }> {
    const result = await this.call('POST', `/api/sessions/${sid}/vault`, body);
    if (result.status !== 201) {
      throw new Error(`credential create failed: ${String(result.status)}`);
    }
    return result.json as { id: string };
  }

  /** The status of POST /api/sessions/:sid/vault/:id/reveal. */
  async revealCredential(sid: string, id: string, field: 'password' | 'totp'): Promise<number> {
    return (await this.call('POST', `/api/sessions/${sid}/vault/${id}/reveal`, { field })).status;
  }

  audit(sid: string, query: AuditQuery): Promise<AuditPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
    return this.ok<AuditPage>('GET', `/api/sessions/${sid}/audit?${params.toString()}`);
  }

  addMember(sid: string, email: string, role: MemberRole): Promise<Member> {
    return this.ok<Member>('POST', `/api/sessions/${sid}/members`, { email, role });
  }

  async removeMember(sid: string, userId: string): Promise<void> {
    await this.ok('DELETE', `/api/sessions/${sid}/members/${userId}`);
  }

  async saveState(path: string): Promise<void> {
    await this.request.storageState({ path });
  }

  async dispose(): Promise<void> {
    await this.request.dispose();
  }
}

/** Creates a session with start=true and waits for running. */
export async function startNewSession(
  api: HydraApi,
  input: CreateSessionRequest,
  timeoutMs = 180_000,
): Promise<SessionResource> {
  const created = await api.createSession({ ...input, start: true });
  return (await api.waitForState(created.id, 'running', timeoutMs)).session;
}

/** Deletes a session and ignores a session that is already gone. */
export async function deleteSessionQuietly(
  api: Pick<HydraApi, 'call'>,
  session: { id: string; name: string },
): Promise<void> {
  const result = await api.call('POST', `/api/sessions/${session.id}/delete`, {
    confirmName: session.name,
  });
  if (result.status !== 404 && (result.status < 200 || result.status > 299)) {
    throw new Error(`Delete of session ${session.id} returned ${result.status}: ${result.text}`);
  }
}

/** Deletes the sessions that earlier e2e runs left (name prefix "e2e-") and waits until they are gone. */
export async function deleteLeftoverSessions(
  api: Pick<HydraApi, 'call' | 'listSessions' | 'waitForGone'>,
): Promise<string[]> {
  const leftovers = (await api.listSessions(true)).filter((session) =>
    session.name.startsWith('e2e-'),
  );
  for (const session of leftovers) {
    await deleteSessionQuietly(api, session);
  }
  for (const session of leftovers) {
    await api.waitForGone(session.id, 180_000);
  }
  return leftovers.map((session) => session.id);
}
