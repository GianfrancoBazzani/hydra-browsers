import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// Test site for the e2e tests (spec section 15.3). Session pods reach it in the dev overlay at
// http://testsite.hydra-testsite.svc.cluster.local/. It sets a cookie and redirects on request.

export const COOKIE_NAME = 'hydra_testsite';
/** 30 days: a persistent cookie, so it is still there after a session stop and start. */
export const COOKIE_MAX_AGE_SECONDS = 2_592_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

/** The account of the vault e2e step (spec section 15.3). Test data only. */
export const TESTSITE_ACCOUNT = {
  email: 'agent@testsite.local',
  password: 'Testsite-Password-1',
  totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
} as const;

function totpCode(secret: string, counter: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of secret) bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(message).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function loginPage(): string {
  return page(
    'Login',
    [
      '<form method="get" action="/login/check">',
      '<p><label>Email <input name="email" type="email" autocomplete="username"></label></p>',
      '<p><label>Password <input name="password" type="password" autocomplete="current-password"></label></p>',
      '<p><label>Code <input name="code" inputmode="numeric" autocomplete="one-time-code"></label></p>',
      '<p><button type="submit">Log in</button></p>',
      '</form>',
    ].join(''),
  );
}

function checkLogin(url: URL, response: ServerResponse): void {
  const email = url.searchParams.get('email') ?? '';
  const password = url.searchParams.get('password') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const counter = Math.floor(Date.now() / 30_000);
  const codeOk = [counter - 1, counter, counter + 1].some((c) =>
    same(code, totpCode(TESTSITE_ACCOUNT.totpSecret, c)),
  );
  const ok =
    same(email, TESTSITE_ACCOUNT.email) && same(password, TESTSITE_ACCOUNT.password) && codeOk;
  sendHtml(
    response,
    ok ? 200 : 401,
    page(
      ok ? 'Logged in' : 'Login failed',
      `<p id="login-result">${ok ? 'Logged in' : 'Login failed'}</p>`,
    ),
  );
}

export function createTestsiteServer(): Server {
  return createServer(handleRequest);
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.setHeader('Allow', 'GET, HEAD');
    sendText(response, 405, 'Method Not Allowed\n');
    return;
  }
  let url: URL;
  try {
    url = new URL(request.url ?? '/', 'http://testsite.invalid');
  } catch {
    // The request line `GET //` is not a valid URL. Without this the process would crash.
    sendText(response, 400, 'Bad Request\n');
    return;
  }
  switch (url.pathname) {
    case '/healthz':
      sendText(response, 200, 'ok\n');
      return;
    case '/':
      sendHtml(response, 200, homePage(readCookies(request)));
      return;
    case '/cookies':
      sendJson(response, 200, { cookies: readCookies(request) });
      return;
    case '/set-cookie':
      setCookie(url, response);
      return;
    case '/redirect':
      redirect(url, response);
      return;
    case '/login':
      sendHtml(response, 200, loginPage());
      return;
    case '/login/check':
      checkLogin(url, response);
      return;
    default:
      sendText(response, 404, 'Not Found\n');
  }
}

function setCookie(url: URL, response: ServerResponse): void {
  const value = url.searchParams.get('value') ?? '';
  if (!COOKIE_VALUE.test(value)) {
    sendText(response, 400, 'value must be 1 to 64 characters of A-Z a-z 0-9 _ -\n');
    return;
  }
  response.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${value}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; SameSite=Lax`,
  );
  sendHtml(response, 200, page('Cookie set', `<p id="cookie">${COOKIE_NAME}=${value}</p>`));
}

function redirect(url: URL, response: ServerResponse): void {
  const target = url.searchParams.get('to') ?? '';
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    sendText(response, 400, 'to must be an absolute http or https URL\n');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    sendText(response, 400, 'to must be an absolute http or https URL\n');
    return;
  }
  response.statusCode = 302;
  response.setHeader('Location', parsed.href);
  response.end();
}

function readCookies(request: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return cookies;
}

function homePage(cookies: Record<string, string>): string {
  const value = cookies[COOKIE_NAME];
  return page(
    'Hydra test site',
    `<p id="cookie">${COOKIE_NAME}=${value === undefined ? '(none)' : escapeHtml(value)}</p>`,
  );
}

function page(title: string, body: string): string {
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>\n`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function sendText(response: ServerResponse, status: number, body: string): void {
  send(response, status, 'text/plain; charset=utf-8', body);
}

function sendHtml(response: ServerResponse, status: number, body: string): void {
  send(response, status, 'text/html; charset=utf-8', body);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  send(response, status, 'application/json; charset=utf-8', `${JSON.stringify(body)}\n`);
}

function send(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.statusCode = status;
  response.setHeader('Content-Type', contentType);
  response.end(body);
}
