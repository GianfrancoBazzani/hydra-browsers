import { eq } from 'drizzle-orm';
import { CredentialSchema, RevealResponseSchema } from '@hydra/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvents, vaultCredentials } from '../../src/db/schema.js';
import { apiRequest, createTestApp, errorOf } from '../helpers/app.js';
import { testConfig } from '../helpers/config.js';
import { loginAs, seedSession, seedUser } from '../helpers/seed.js';

type TestApp = Awaited<ReturnType<typeof createTestApp>>;
let t: TestApp;
let sid: string;
const cookies: Record<'owner' | 'operator' | 'viewer' | 'admin' | 'outsider', string> = {
  owner: '',
  operator: '',
  viewer: '',
  admin: '',
  outsider: '',
};

const NEW = {
  name: 'Google - Catalina',
  website: 'www.google.com',
  username: 'catalina@example.com',
  password: 'hunter2-secret',
  totp: { secret: 'JBSWY3DPEHPK3PXP' },
};

beforeEach(async () => {
  t = await createTestApp({ config: testConfig({ vaultHttpHosts: ['testsite.local'] }) });
  const users = {
    owner: await seedUser(t.deps, { email: 'owner@example.com' }),
    operator: await seedUser(t.deps, { email: 'operator@example.com' }),
    viewer: await seedUser(t.deps, { email: 'viewer@example.com' }),
    admin: await seedUser(t.deps, { email: 'admin@example.com', role: 'admin' }),
    outsider: await seedUser(t.deps, { email: 'outsider@example.com' }),
  };
  sid = seedSession(t.deps, { ownerId: users.owner.user.id }).id;
  for (const [role, seeded] of Object.entries(users)) {
    cookies[role as keyof typeof cookies] = await loginAs(
      t.app,
      seeded.user.email,
      seeded.password,
    );
  }
  for (const role of ['operator', 'viewer'] as const) {
    const res = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/members`,
      cookie: cookies.owner,
      body: { email: `${role}@example.com`, role },
    });
    expect(res.statusCode).toBeLessThan(300);
  }
});

afterEach(async () => {
  await t.close();
});

async function create(cookie = cookies.owner, body: unknown = NEW) {
  return apiRequest(t.app, { method: 'POST', url: `/api/sessions/${sid}/vault`, cookie, body });
}

describe('vault API', () => {
  it('creates, lists, updates, and deletes a credential (owner)', async () => {
    const created = await create();
    expect(created.statusCode).toBe(201);
    const credential = CredentialSchema.parse(created.json());
    expect(credential).toMatchObject({
      website: 'https://www.google.com',
      hasPassword: true,
      hasTotp: true,
    });

    const list = await apiRequest(t.app, {
      method: 'GET',
      url: `/api/sessions/${sid}/vault`,
      cookie: cookies.viewer,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain('hunter2-secret');
    expect(list.body).not.toContain('JBSWY3DPEHPK3PXP');

    const patched = await apiRequest(t.app, {
      method: 'PATCH',
      url: `/api/sessions/${sid}/vault/${credential.id}`,
      cookie: cookies.owner,
      body: { password: null },
    });
    expect(patched.json()).toMatchObject({ hasPassword: false, hasTotp: true });

    const removed = await apiRequest(t.app, {
      method: 'DELETE',
      url: `/api/sessions/${sid}/vault/${credential.id}`,
      cookie: cookies.owner,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('applies the rights of spec section 6.9.5', async () => {
    const { id } = CredentialSchema.parse((await create()).json());
    expect((await create(cookies.operator)).statusCode).toBe(403);
    expect((await create(cookies.viewer)).statusCode).toBe(403);
    expect((await create(cookies.outsider)).statusCode).toBe(404);
    const reveal = (cookie: string) =>
      apiRequest(t.app, {
        method: 'POST',
        url: `/api/sessions/${sid}/vault/${id}/reveal`,
        cookie,
        body: { field: 'password' },
      });
    expect((await reveal(cookies.operator)).statusCode).toBe(403);
    expect((await reveal(cookies.viewer)).statusCode).toBe(403);
    const byAdmin = await reveal(cookies.admin);
    expect(byAdmin.statusCode).toBe(200);
    expect(byAdmin.headers['cache-control']).toBe('no-store');
    expect(RevealResponseSchema.parse(byAdmin.json())).toEqual({
      field: 'password',
      value: 'hunter2-secret',
    });
    const kinds = t.deps.db
      .select()
      .from(auditEvents)
      .all()
      .map((row) => row.kind);
    expect(kinds).toContain('vault.revealed');
    expect(kinds).toContain('admin.session_access');
  });

  it('gives vault_limit_reached at 50 credentials and validation errors on the field', async () => {
    for (let i = 0; i < 50; i++)
      expect((await create(cookies.owner, { ...NEW, name: `c${String(i)}` })).statusCode).toBe(201);
    const over = await create();
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).code).toBe('vault_limit_reached');

    const bad = await create(cookies.owner, {
      name: 'x',
      website: 'http://example.com',
      password: 'p',
    });
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad).fields).toHaveProperty('website');
    const http = await create(cookies.owner, {
      name: 'x',
      website: 'http://testsite.local',
      password: 'p',
    });
    expect(http.statusCode).toBe(409); // still over the limit: the http rule passed
  });

  it('deletes the credentials when the session is deleted', async () => {
    await create();
    const res = await apiRequest(t.app, {
      method: 'POST',
      url: `/api/sessions/${sid}/delete`,
      cookie: cookies.owner,
      body: { confirmName: 'Test session' },
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(
      t.deps.db.select().from(vaultCredentials).where(eq(vaultCredentials.sessionId, sid)).all(),
    ).toEqual([]);
  });
});
