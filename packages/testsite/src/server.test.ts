import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { connect, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  COOKIE_MAX_AGE_SECONDS,
  COOKIE_NAME,
  TESTSITE_ACCOUNT,
  createTestsiteServer,
} from './server.js';

const server = createTestsiteServer();
let baseUrl = '';

beforeAll(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  server.close();
  await once(server, 'close');
});

function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers, redirect: 'manual' });
}

describe('testsite', () => {
  it('answers the health check', async () => {
    const response = await get('/healthz');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok\n');
  });

  it('sets a persistent cookie', async () => {
    const response = await get('/set-cookie?value=abc_123');
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toBe(
      `${COOKIE_NAME}=abc_123; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`,
    );
    expect(await response.text()).toContain(`${COOKIE_NAME}=abc_123`);
  });

  it('rejects a cookie value that is missing or has other characters', async () => {
    expect((await get('/set-cookie')).status).toBe(400);
    expect((await get('/set-cookie?value=a%3Bb')).status).toBe(400);
    expect((await get(`/set-cookie?value=${'x'.repeat(65)}`)).status).toBe(400);
  });

  it('shows the cookie that the browser sends', async () => {
    const response = await get('/', { cookie: `other=1; ${COOKIE_NAME}=xyz` });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain(`<p id="cookie">${COOKIE_NAME}=xyz</p>`);
  });

  it('shows (none) without the cookie', async () => {
    expect(await (await get('/')).text()).toContain(`<p id="cookie">${COOKIE_NAME}=(none)</p>`);
  });

  it('escapes HTML in a cookie value from the request', async () => {
    const body = await (await get('/', { cookie: `${COOKIE_NAME}=<b>"x"` })).text();
    expect(body).toContain(`${COOKIE_NAME}=&lt;b&gt;&quot;x&quot;`);
    expect(body).not.toContain('<b>');
  });

  it('returns the cookies as JSON', async () => {
    const response = await get('/cookies', { cookie: `${COOKIE_NAME}=v1; a=b` });
    expect(await response.json()).toEqual({ cookies: { [COOKIE_NAME]: 'v1', a: 'b' } });
  });

  it('redirects to an absolute http or https URL', async () => {
    const response = await get('/redirect?to=https%3A%2F%2Fexample.com%2Fpath%3Fq%3D1');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://example.com/path?q=1');
  });

  it('rejects a redirect target that is not an absolute http or https URL', async () => {
    expect((await get('/redirect')).status).toBe(400);
    expect((await get('/redirect?to=%2Frelative')).status).toBe(400);
    expect((await get('/redirect?to=javascript%3Aalert(1)')).status).toBe(400);
  });

  it('allows only GET and HEAD', async () => {
    const response = await fetch(`${baseUrl}/`, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    expect((await fetch(`${baseUrl}/healthz`, { method: 'HEAD' })).status).toBe(200);
  });

  it('returns 404 for an unknown path', async () => {
    expect((await get('/nope')).status).toBe(404);
  });

  it('answers 400 to a request line that is not a valid URL and keeps running', async () => {
    const { port } = server.address() as AddressInfo;
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      let data = '';
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (data += chunk));
      socket.on('end', () => resolve(data));
      socket.on('error', reject);
      socket.write('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    });
    expect(raw.startsWith('HTTP/1.1 400 ')).toBe(true);
    expect(raw.toLowerCase()).toContain('cache-control: no-store');
    expect((await get('/healthz')).status).toBe(200);
  });

  it('turns off caching', async () => {
    expect((await get('/')).headers.get('cache-control')).toBe('no-store');
  });
});

function code(secret: string, timeMs: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(timeMs / 30_000)));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

describe('login page (spec section 15.3)', () => {
  it('shows a form with email, password, and code fields', async () => {
    const res = await get('/login');
    expect(res.status).toBe(200);
    const body = await res.text();
    for (const name of ['email', 'password', 'code']) expect(body).toContain(`name="${name}"`);
  });

  it('accepts the test account with a current TOTP code, and rejects others', async () => {
    const { email, password, totpSecret } = TESTSITE_ACCOUNT;
    const query = (pw: string, otp: string) =>
      `/login/check?email=${encodeURIComponent(email)}&password=${encodeURIComponent(pw)}&code=${otp}`;
    const ok = await get(query(password, code(totpSecret, Date.now())));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain('<p id="login-result">Logged in</p>');
    const bad = await get(query('x', '000000'));
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain(password);
  });
});
