import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../../src/app.js';
import { createTestApp } from '../helpers/app.js';
import { seedSession } from '../helpers/seed.js';
import { grantFor, loggedInUser, publicHeaders, requestTicket } from './live-helpers.js';

let app: FastifyInstance;
let deps: AppDeps;
let testApp: Awaited<ReturnType<typeof createTestApp>>;

beforeEach(async () => {
  testApp = await createTestApp();
  ({ app, deps } = testApp);
});

afterEach(async () => {
  await testApp.close();
});

describe('POST /api/sessions/:sid/live-ticket', () => {
  it('returns { url } with the ticket', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const response = await requestTicket(app, deps, owner.cookie, session.id);
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(['url']);
    expect(response.json<{ url: string }>().url).toMatch(
      new RegExp(`^http://live\\.hydra\\.localhost/s/${session.id}/\\?ticket=[A-Za-z0-9_-]{43}$`),
    );
  });

  it('answers 401 without login, 404 without access, and 409 when the session is not running', async () => {
    const owner = await loggedInUser(app, deps);
    const stranger = await loggedInUser(app, deps);
    const running = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const stopped = seedSession(deps, { ownerId: owner.userId, state: 'stopped' });

    const noLogin = await requestTicket(app, deps, '', running.id);
    expect(noLogin.statusCode).toBe(401);
    expect(noLogin.json()).toMatchObject({ error: { code: 'unauthenticated' } });
    const noAccess = await requestTicket(app, deps, stranger.cookie, running.id);
    expect(noAccess.statusCode).toBe(404);
    expect(noAccess.json()).toMatchObject({ error: { code: 'not_found' } });
    const notRunning = await requestTicket(app, deps, owner.cookie, stopped.id);
    expect(notRunning.statusCode).toBe(409);
    expect(notRunning.json()).toMatchObject({ error: { code: 'invalid_state' } });
  });
});

describe('DELETE /api/sessions/:sid/live-grant', () => {
  it('ends the grants of this login session for the session and answers 204', async () => {
    const owner = await loggedInUser(app, deps);
    const session = seedSession(deps, { ownerId: owner.userId, state: 'running' });
    const { cookieValue } = grantFor(deps, owner.context, session.id);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}/live-grant`,
      headers: publicHeaders(deps, owner.cookie),
      payload: {},
    });
    expect(response.statusCode).toBe(204);
    expect(deps.live.validateGrant(session.id, cookieValue)).toBeNull();
  });

  it('answers 401 without login', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/abcdefgh2345/live-grant',
      headers: publicHeaders(deps, ''),
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });
});
