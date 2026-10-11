import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../src/app.js';
import type { AuthedUser, LoginContext } from '../../src/auth/index.js';
import { sessions, users } from '../../src/db/schema.js';
import { createTestApp } from '../helpers/app.js';
import { FakeKubeClient } from '../helpers/fake-kube.js';
import { loginAs, seedUser } from '../helpers/seed.js';

interface SseEvent {
  event: string;
  data: unknown;
}

interface SseClient {
  status: number;
  next(timeoutMs?: number): Promise<SseEvent>;
  ended: Promise<void>;
  close(): void;
}

let app: FastifyInstance;
let deps: AppDeps;
let close: () => Promise<void>;
let kube: FakeKubeClient;
let port: number;
const clients: SseClient[] = [];

/** Opens GET /api/events on the listening server and parses the SSE frames. */
function openEvents(cookie: string): Promise<SseClient> {
  return new Promise((resolve, reject) => {
    const queue: SseEvent[] = [];
    const waiters: Array<(event: SseEvent) => void> = [];
    let buffer = '';
    let resolveEnded!: () => void;
    const ended = new Promise<void>((r) => (resolveEnded = r));
    const req: ClientRequest = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: '/api/events',
        headers: { host: deps.config.publicUrl.host, cookie, accept: 'text/event-stream' },
      },
      (res: IncomingMessage) => {
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buffer += chunk;
          let index: number;
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const lines = frame.split('\n').filter((line) => !line.startsWith(':'));
            const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
            const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
            if (!event || data === undefined) continue;
            const parsed: SseEvent = { event, data: JSON.parse(data) };
            const waiter = waiters.shift();
            if (waiter) waiter(parsed);
            else queue.push(parsed);
          }
        });
        res.on('end', resolveEnded);
        res.on('close', resolveEnded);
        const client: SseClient = {
          status: res.statusCode ?? 0,
          next: (timeoutMs = 2_000) =>
            new Promise<SseEvent>((resolveNext, rejectNext) => {
              const queued = queue.shift();
              if (queued) return resolveNext(queued);
              const timer = setTimeout(() => rejectNext(new Error('no SSE event')), timeoutMs);
              waiters.push((event) => {
                clearTimeout(timer);
                resolveNext(event);
              });
            }),
          ended,
          close: () => req.destroy(),
        };
        clients.push(client);
        resolve(client);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function login(
  role: 'admin' | 'member' = 'member',
): Promise<{ user: AuthedUser; cookie: string; context: LoginContext }> {
  const { user, password } = await seedUser(deps, { role });
  return {
    user,
    cookie: await loginAs(app, user.email, password),
    context: { user, loginSessionId: 'service-call' },
  };
}

beforeEach(async () => {
  kube = new FakeKubeClient();
  const testApp = await createTestApp({ kube });
  ({ app, deps } = testApp);
  close = () => testApp.close();
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  await close();
});

describe('GET /api/events', () => {
  it('needs a login', async () => {
    const client = await openEvents('');
    expect(client.status).toBe(401);
  });

  it('sends session.state of readable sessions from the reconciler', async () => {
    const owner = await login();
    const stranger = await login();
    const own = deps.sessions.create(owner.context, { name: 'Own', allowlist: ['example.com'] }).id;
    const hidden = deps.sessions.create(stranger.context, {
      name: 'Hidden',
      allowlist: ['example.com'],
    }).id;
    const client = await openEvents(owner.cookie);
    expect(client.status).toBe(200);

    await deps.reconciler.reconcileSession(hidden);
    await deps.reconciler.reconcileSession(own);
    expect(await client.next()).toEqual({
      event: 'session.state',
      data: { sessionId: own, state: 'starting', errorReason: null },
    });
  });

  it('sends session.activity of readable sessions only', async () => {
    const owner = await login();
    const stranger = await login();
    const own = deps.sessions.create(owner.context, {
      name: 'Own',
      allowlist: ['*'],
      start: false,
    }).id;
    const hidden = deps.sessions.create(stranger.context, {
      name: 'Hidden',
      allowlist: ['*'],
      start: false,
    }).id;
    const client = await openEvents(owner.cookie);
    const agentActivity = {
      activeAgentCount: 1,
      lastToolCall: { tool: 'browser_click', status: 'ok' as const, durationMs: 230, startedAt: 1 },
    };
    deps.bus.publish({ type: 'session.activity', sessionId: hidden, agentActivity });
    deps.bus.publish({ type: 'session.activity', sessionId: own, agentActivity });
    expect(await client.next()).toEqual({
      event: 'session.activity',
      data: { sessionId: own, agentActivity },
    });
  });

  it('closes the streams of the user on rights.changed, and only these', async () => {
    const admin = await login('admin');
    const member = await login();
    const sid = deps.sessions.create(member.context, {
      name: 'Member',
      allowlist: ['*'],
      start: false,
    }).id;
    const client = await openEvents(admin.cookie);
    expect(client.status).toBe(200);

    // A rights change of another user does not close the stream.
    deps.bus.publish({ type: 'rights.changed', userId: member.user.id });
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'starting',
      previous: 'stopped',
      errorReason: null,
    });
    expect((await client.next()).data).toMatchObject({ sessionId: sid, state: 'starting' });

    // The admin becomes a member: the stream closes (spec sections 6.5 and 10.3).
    deps.db.update(users).set({ role: 'member' }).where(eq(users.id, admin.user.id)).run();
    deps.bus.publish({ type: 'rights.changed', userId: admin.user.id });
    await client.ended;

    // The new stream has the new rights: no events of the session of the other user.
    const again = await openEvents(admin.cookie);
    expect(again.status).toBe(200);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'running',
      previous: 'starting',
      errorReason: null,
    });
    await expect(again.next(200)).rejects.toThrow('no SSE event');
  });

  it('sends events of a session that the user creates after the stream opened', async () => {
    const owner = await login();
    const client = await openEvents(owner.cookie);
    const sid = deps.sessions.create(owner.context, { name: 'Later', allowlist: ['*'] }).id;
    await deps.reconciler.reconcileSession(sid);
    expect(await client.next()).toEqual({
      event: 'session.state',
      data: { sessionId: sid, state: 'starting', errorReason: null },
    });
  });

  it('closes the stream of a new member, and the new stream sends the events of the shared session', async () => {
    const owner = await login();
    const viewer = await login();
    const client = await openEvents(viewer.cookie);
    expect(client.status).toBe(200);
    const sid = deps.sessions.create(owner.context, { name: 'Later', allowlist: ['*'] }).id;
    deps.access.addMember(owner.context, sid, { email: viewer.user.email, role: 'viewer' });
    await client.ended;

    const again = await openEvents(viewer.cookie);
    await deps.reconciler.reconcileSession(sid);
    expect(await again.next()).toEqual({
      event: 'session.state',
      data: { sessionId: sid, state: 'starting', errorReason: null },
    });
  });

  it('closes the stream when the member is removed', async () => {
    const owner = await login();
    const viewer = await login();
    const sid = deps.sessions.create(owner.context, {
      name: 'Shared',
      allowlist: ['*'],
      start: false,
    }).id;
    deps.access.addMember(owner.context, sid, { email: viewer.user.email, role: 'viewer' });
    const client = await openEvents(viewer.cookie);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'starting',
      previous: 'stopped',
      errorReason: null,
    });
    expect((await client.next()).data).toMatchObject({ sessionId: sid });

    deps.access.removeMember(owner.context, sid, viewer.user.id);
    await client.ended;

    const again = await openEvents(viewer.cookie);
    expect(again.status).toBe(200);
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'running',
      previous: 'starting',
      errorReason: null,
    });
    await expect(again.next(200)).rejects.toThrow('no SSE event');
  });

  it('sends the last deleted state event of a session that has deletedAt set', async () => {
    const owner = await login();
    const viewer = await login();
    const sid = deps.sessions.create(owner.context, {
      name: 'Doomed',
      allowlist: ['*'],
      start: false,
    }).id;
    deps.access.addMember(owner.context, sid, { email: viewer.user.email, role: 'viewer' });
    const ownerStream = await openEvents(owner.cookie);
    // Opened after addMember: addMember closes the streams of the new member.
    const viewerStream = await openEvents(viewer.cookie);
    deps.db
      .update(sessions)
      .set({ state: 'deleted', desiredState: 'deleted', deletedAt: deps.clock.now() })
      .where(eq(sessions.id, sid))
      .run();
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'deleted',
      previous: 'deleting',
      errorReason: null,
    });
    const expected = {
      event: 'session.state',
      data: { sessionId: sid, state: 'deleted', errorReason: null },
    };
    expect(await ownerStream.next()).toEqual(expected);
    expect(await viewerStream.next()).toEqual(expected);
  });

  it('a login.ended event of another login session of the user does not close the stream', async () => {
    const owner = await login();
    const sid = deps.sessions.create(owner.context, {
      name: 'Own',
      allowlist: ['*'],
      start: false,
    }).id;
    const client = await openEvents(owner.cookie);
    expect(client.status).toBe(200);
    deps.bus.publish({
      type: 'login.ended',
      userId: owner.user.id,
      loginSessionIds: ['some-other-login-session'],
    });
    // The stream is open: the next event arrives. (Events are in order: nothing closed it before.)
    deps.bus.publish({
      type: 'session.state',
      sessionId: sid,
      state: 'starting',
      previous: 'stopped',
      errorReason: null,
    });
    expect(await client.next()).toEqual({
      event: 'session.state',
      data: { sessionId: sid, state: 'starting', errorReason: null },
    });
  });

  it('closes the stream when its login session ends', async () => {
    const owner = await login();
    const client = await openEvents(owner.cookie);
    expect(client.status).toBe(200);
    deps.auth.endLoginSessions(owner.user.id);
    await client.ended;
  });
});
