import { vi } from 'vitest';

export interface MockResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
  credentials: RequestCredentials | undefined;
}

type Handler = MockResponse | ((request: RecordedRequest) => MockResponse | Promise<MockResponse>);

/** An error body of spec section 12.2. */
export function apiError(
  status: number,
  code: string,
  message: string,
  fields?: Record<string, string>,
): MockResponse {
  return { status, body: { error: { code, message, ...(fields ? { fields } : {}) } } };
}

/**
 * A fetch mock with routes like "GET /api/sessions" (path without the query string).
 * `on(route, a, b)` answers the first call with `a` and all later calls with `b`.
 * A request without a route gets 404 `not_found` and is kept in `unmatched`.
 */
export class MockApi {
  readonly requests: RecordedRequest[] = [];
  readonly unmatched: string[] = [];
  private readonly routes = new Map<string, Handler[]>();

  on(route: string, ...handlers: Handler[]): this {
    this.routes.set(route, handlers);
    return this;
  }

  calls(route: string): RecordedRequest[] {
    return this.requests.filter((r) => `${r.method} ${r.path}` === route);
  }

  install(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => this.handle(input, init)),
    );
  }

  private async handle(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      'http://hydra.localhost',
    );
    const method = (init.method ?? 'GET').toUpperCase();
    const request: RecordedRequest = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: new Headers(init.headers),
      credentials: init.credentials,
    };
    this.requests.push(request);
    const route = `${method} ${url.pathname}`;
    const handlers = this.routes.get(route);
    let result: MockResponse;
    if (!handlers || handlers.length === 0) {
      this.unmatched.push(route);
      result = apiError(404, 'not_found', `No mock for ${route}`);
    } else {
      const handler = handlers.length > 1 ? handlers.shift() : handlers[0];
      result = typeof handler === 'function' ? await handler(request) : (handler ?? {});
    }
    const status = result.status ?? 200;
    if (status === 204 || result.body === undefined) {
      return new Response(null, { status: status === 200 ? 204 : status, headers: result.headers });
    }
    return new Response(JSON.stringify(result.body), {
      status,
      headers: { 'Content-Type': 'application/json', ...result.headers },
    });
  }
}

export function mockApi(): MockApi {
  const api = new MockApi();
  api.install();
  return api;
}
