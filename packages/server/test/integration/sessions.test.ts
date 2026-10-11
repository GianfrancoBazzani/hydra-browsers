import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LogsResponseSchema, SessionResourceSchema, type SessionResource } from '@hydra/shared';
import type { AppDeps } from '../../src/app.js';
import type { AuthedUser } from '../../src/auth/index.js';
import { createTestApp } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { FakeKubeClient } from '../helpers/fake-kube.js';
import { loginAs, seedUser } from '../helpers/seed.js';

let app: FastifyInstance;
let deps: AppDeps;
let close: () => Promise<void>;
let kube: FakeKubeClient;
let owner: { user: AuthedUser; cookie: string };

async function login(
  role: 'admin' | 'member' = 'member',
): Promise<{ user: AuthedUser; cookie: string }> {
  const { user, password } = await seedUser(deps, { role });
  return { user, cookie: await loginAs(app, user.email, password) };
}

function call(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  cookie: string | null,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  const headers: Record<string, string> = { host: deps.config.publicUrl.host };
  if (cookie) headers['cookie'] = cookie;
  if (method === 'GET') return app.inject({ method, url, headers });
  headers['origin'] = deps.config.publicUrl.origin;
  headers['content-type'] = 'application/json';
  return app.inject({ method, url, headers, payload: JSON.stringify(body ?? {}) });
}

async function createSession(body: Record<string, unknown> = {}): Promise<SessionResource> {
  const response = await call('POST', '/api/sessions', owner.cookie, {
    name: 'Research',
    allowlist: ['example.com'],
    ...body,
  });
  expect(response.statusCode).toBe(201);
  return SessionResourceSchema.parse(response.json());
}

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp({
    kube,
    config: testConfig({ maxRunning: 1, mediaPortRange: { first: 52000, last: 52001 } }),
  });
  ({ app, deps } = testApp);
  close = () => testApp.close();
  owner = await login();
});

afterEach(async () => {
  await close();
});

describe('session routes', () => {
  it('creates a session and returns the session resource', async () => {
    const resource = await createSession({
      timezone: 'Europe/Rome',
      language: 'it-IT',
      screen: '1600x900',
    });
    expect(resource).toMatchObject({
      name: 'Research',
      myRole: 'owner',
      state: 'stopped',
      settings: {
        allowlist: ['example.com'],
        timezone: 'Europe/Rome',
        language: 'it-IT',
        screen: '1600x900',
      },
    });
  });

  it('rejects a body that is not valid', async () => {
    const response = await call('POST', '/api/sessions', owner.cookie, {
      name: '',
      allowlist: ['https://example.com/path'],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const fields = response.json<{ error: { fields: Record<string, string> } }>().error.fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['name']));
  });

  it('needs a login and the CSRF headers', async () => {
    expect((await call('GET', '/api/sessions', null)).statusCode).toBe(401);
    const response = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: {
        host: deps.config.publicUrl.host,
        cookie: owner.cookie,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ name: 'x', allowlist: ['example.com'] }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: 'csrf_failed' } });
  });

  it('returns 404 to a user without access, and 403 to a viewer for a lifecycle action', async () => {
    const { id } = await createSession();
    const stranger = await login();
    expect((await call('GET', `/api/sessions/${id}`, stranger.cookie)).statusCode).toBe(404);
    expect((await call('POST', `/api/sessions/${id}/stop`, stranger.cookie)).statusCode).toBe(404);
    expect(
      (
        await call('POST', `/api/sessions/${id}/delete`, stranger.cookie, {
          confirmName: 'Research',
        })
      ).statusCode,
    ).toBe(404);

    const viewer = await login();
    deps.access.addMember({ user: owner.user, loginSessionId: 'x' }, id, {
      email: viewer.user.email,
      role: 'viewer',
    });
    const asViewer = await call('GET', `/api/sessions/${id}`, viewer.cookie);
    expect(asViewer.statusCode).toBe(200);
    expect(asViewer.json()).toMatchObject({
      myRole: 'viewer',
      rights: ['session.read', 'live.watch'],
    });
    const stop = await call('POST', `/api/sessions/${id}/stop`, viewer.cookie);
    expect(stop.statusCode).toBe(403);
    expect(stop.json()).toMatchObject({ error: { code: 'forbidden' } });
  });

  it('a stranger who posts delete with a missing or wrong confirmName gets 404, not confirm_mismatch', async () => {
    const { id } = await createSession();
    const stranger = await login();
    for (const body of [{}, { confirmName: 'wrong name' }, { confirmName: 5 }]) {
      const response = await call('POST', `/api/sessions/${id}/delete`, stranger.cookie, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(404);
      expect(response.json()).toMatchObject({ error: { code: 'not_found' } });
    }
    // The session is untouched.
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).statusCode).toBe(200);
  });

  it('a viewer who posts delete gets 403, also with the right name', async () => {
    const { id } = await createSession();
    const viewer = await login();
    deps.access.addMember({ user: owner.user, loginSessionId: 'x' }, id, {
      email: viewer.user.email,
      role: 'viewer',
    });
    for (const body of [{ confirmName: 'Research' }, {}]) {
      const response = await call('POST', `/api/sessions/${id}/delete`, viewer.cookie, body);
      expect(response.statusCode, JSON.stringify(body)).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: 'forbidden' } });
    }
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).statusCode).toBe(200);
  });

  it('PATCH with a body that is not valid answers 400 validation_failed with fields', async () => {
    const { id } = await createSession({ start: false });
    const response = await call('PATCH', `/api/sessions/${id}`, owner.cookie, {
      name: '',
      allowlist: ['https://example.com/path'],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'validation_failed' } });
    const fields = response.json<{ error: { fields: Record<string, string> } }>().error.fields;
    expect(Object.keys(fields)).toEqual(expect.arrayContaining(['name']));
    // The session is unchanged.
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).json()).toMatchObject({
      name: 'Research',
      settings: { allowlist: ['example.com'] },
    });
  });

  it('lists own sessions, and all sessions with all=1 for an admin only', async () => {
    const { id } = await createSession({ start: false });
    const other = await login();
    const otherList = await call('GET', '/api/sessions?all=1', other.cookie);
    expect(otherList.json()).toEqual([]);
    const admin = await login('admin');
    expect((await call('GET', '/api/sessions', admin.cookie)).json()).toEqual([]);
    const all = await call('GET', '/api/sessions?all=1', admin.cookie);
    expect(all.json<SessionResource[]>().map((s) => [s.id, s.myRole])).toEqual([[id, 'admin']]);
  });

  it('starts, stops, and restarts with the state rules', async () => {
    const first = await createSession({ start: false });
    const second = await createSession({ start: false, name: 'Second' });
    const start = await call('POST', `/api/sessions/${first.id}/start`, owner.cookie);
    expect(start.statusCode).toBe(200);
    const full = await call('POST', `/api/sessions/${second.id}/start`, owner.cookie);
    expect(full.statusCode).toBe(409);
    expect(full.json()).toMatchObject({ error: { code: 'capacity_reached' } });

    const restartStopped = await call('POST', `/api/sessions/${second.id}/restart`, owner.cookie);
    expect(restartStopped.statusCode).toBe(409);
    expect(restartStopped.json()).toMatchObject({ error: { code: 'invalid_state' } });

    await deps.reconciler.reconcileSession(first.id);
    const restart = await call('POST', `/api/sessions/${first.id}/restart`, owner.cookie);
    expect(restart.statusCode).toBe(200);
    const stop = await call('POST', `/api/sessions/${first.id}/stop`, owner.cookie);
    expect(stop.statusCode).toBe(200);
  });

  it('shows restartRequired after a settings change of a running session', async () => {
    const { id } = await createSession();
    await deps.reconciler.reconcileSession(id);
    kube.setPodReady(id, true);
    await deps.reconciler.reconcileSession(id);
    const patch = await call('PATCH', `/api/sessions/${id}`, owner.cookie, {
      allowlist: ['other.example.com'],
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({
      state: 'running',
      restartRequired: true,
      settings: { allowlist: ['other.example.com'] },
    });
  });

  it('deletes with the exact name, and the reconciler removes the objects', async () => {
    const { id } = await createSession();
    await deps.reconciler.reconcileSession(id);
    expect(kube.objectsOf(id).length).toBeGreaterThan(0);

    const missing = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {});
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: 'confirm_mismatch' } });
    const wrong = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {
      confirmName: 'research',
    });
    expect(wrong.json()).toMatchObject({ error: { code: 'confirm_mismatch' } });

    const ok = await call('POST', `/api/sessions/${id}/delete`, owner.cookie, {
      confirmName: 'Research',
    });
    expect(ok.statusCode).toBe(204);
    await deps.reconciler.reconcileSession(id);
    expect(kube.objectsOf(id)).toEqual([]);
    await deps.reconciler.reconcileSession(id);
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).statusCode).toBe(404);
  });

  it('reads container logs', async () => {
    const { id } = await createSession();
    kube.setLog(`session-${id}-0`, 'neko', 'started\nready\n');
    const response = await call('GET', `/api/sessions/${id}/logs?container=neko`, owner.cookie);
    expect(response.statusCode).toBe(200);
    expect(LogsResponseSchema.parse(response.json())).toEqual({
      container: 'neko',
      lines: ['started', 'ready'],
    });
    expect(
      (await call('GET', `/api/sessions/${id}/logs?container=other`, owner.cookie)).statusCode,
    ).toBe(400);
  });

  it('reaches running through the started reconciler after the API action', async () => {
    await deps.reconciler.start();
    const { id } = await createSession();
    await deps.reconciler.idle();
    kube.setPodReady(id, true);
    await deps.reconciler.idle();
    expect((await call('GET', `/api/sessions/${id}`, owner.cookie)).json()).toMatchObject({
      state: 'running',
    });
  });
});

describe('GET /readyz', () => {
  it('needs the database and the Kubernetes API', async () => {
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    kube.pingResult = false;
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });

  it('answers 503 with the failing check when the Kubernetes ping fails', async () => {
    kube.pingResult = false;
    const response = await app.inject({ method: 'GET', url: '/readyz' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: 'unavailable',
      checks: { db: true, kubernetes: false },
    });
  });
});
