import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, errorOf, LIVE_HOST, PUBLIC_HOST } from '../helpers/app.js';

const INDEX = '<!doctype html><title>Hydra</title>';
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-src http://live.hydra.localhost; " +
  "img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

describe('dashboard build (spec section 6.8)', () => {
  let webRoot: string;
  let t: Awaited<ReturnType<typeof createTestApp>>;

  beforeAll(() => {
    webRoot = mkdtempSync(join(tmpdir(), 'hydra-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), INDEX);
    writeFileSync(join(webRoot, 'assets', 'index-4f2a9c.js'), 'console.log("hydra");');
    writeFileSync(join(webRoot, '.env'), 'SECRET=1');
  });

  afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

  afterEach(async () => {
    await t.close();
  });

  const get = (url: string, host = PUBLIC_HOST, method: 'GET' | 'HEAD' = 'GET') =>
    t.app.inject({ method, url, headers: { host } });

  it('serves index.html at / and for app routes, with the dashboard headers and no-cache', async () => {
    t = await createTestApp({ webRoot });
    for (const url of ['/', '/sessions/abcdefghijkl/live', '/admin/users?tab=1']) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(200);
      expect(response.body).toBe(INDEX);
      expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(response.headers['cache-control']).toBe('no-cache');
      expect(response.headers['content-security-policy']).toBe(CSP);
      expect(response.headers['strict-transport-security']).toBe('max-age=31536000');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
  });

  it('serves hashed assets with a long cache, HEAD, and 304', async () => {
    t = await createTestApp({ webRoot });
    const response = await get('/assets/index-4f2a9c.js');
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect((await get('/assets/index-4f2a9c.js', PUBLIC_HOST, 'HEAD')).statusCode).toBe(200);
    const cached = await t.app.inject({
      method: 'GET',
      url: '/assets/index-4f2a9c.js',
      headers: { host: PUBLIC_HOST, 'if-none-match': String(response.headers.etag) },
    });
    expect(cached.statusCode).toBe(304);
    expect(cached.headers['content-security-policy']).toBe(CSP);
  });

  it('answers 404 JSON for missing files, unknown API paths, dot files, and path traversal', async () => {
    t = await createTestApp({ webRoot });
    for (const url of [
      '/assets/missing.js',
      '/api/unknown',
      '/api/unknown?x=1',
      '/%61pi/unknown',
      '/%61pi/auth/nope',
      '//api/x',
      '/.env',
      '/../package.json',
      '/%2e%2e/package.json',
    ]) {
      const response = await get(url);
      expect(response.statusCode, url).toBe(404);
      expect(errorOf(response).code).toBe('not_found');
    }
  });

  it('serves nothing on other hosts', async () => {
    t = await createTestApp({ webRoot });
    for (const host of [LIVE_HOST, 'evil.example']) {
      expect((await get('/', host)).statusCode).toBe(404);
      expect((await get('/assets/index-4f2a9c.js', host)).statusCode).toBe(404);
    }
  });

  it('serves no dashboard without a build folder', async () => {
    t = await createTestApp({ webRoot: null });
    expect((await get('/')).statusCode).toBe(404);
  });
});
