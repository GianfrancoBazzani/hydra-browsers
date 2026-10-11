import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

// Test site for the e2e tests (spec section 15.3). Session pods reach it in the dev overlay at
// http://testsite.hydra-testsite.svc.cluster.local/. It sets a cookie and redirects on request.

export const COOKIE_NAME = 'hydra_testsite';
/** 30 days: a persistent cookie, so it is still there after a session stop and start. */
export const COOKIE_MAX_AGE_SECONDS = 2_592_000;
const COOKIE_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

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
