import { ApiErrorSchema, type ErrorCode } from '@hydra/shared';

/** Error codes of spec section 12.2, plus the codes of failures that happen in the client. */
export type ClientErrorCode = ErrorCode | 'network_error' | 'invalid_response' | 'http_error';

/** The error that every API call throws. It wraps the `ApiError` body of @hydra/shared. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ClientErrorCode;
  readonly fields: Readonly<Record<string, string>> | undefined;
  /** Seconds from the Retry-After header of a 429 response. */
  readonly retryAfter: number | null;

  constructor(
    status: number,
    code: ClientErrorCode,
    message: string,
    fields?: Record<string, string>,
    retryAfter: number | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.retryAfter = retryAfter;
  }
}

/** A zod schema of @hydra/shared, or anything else with `parse`. */
export interface Parser<T> {
  parse: (data: unknown) => T;
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  method?: HttpMethod;
  /** JSON body. Requests that are not GET send `{}` when it is missing (spec section 6.4). */
  body?: unknown;
  /** Validates the response body. Without it, the call returns undefined. */
  schema?: Parser<T>;
  query?: Record<string, string | number | undefined>;
  signal?: AbortSignal;
}

function withQuery(path: string, query: RequestOptions<unknown>['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const text = params.toString();
  return text === '' ? path : `${path}?${text}`;
}

async function toApiError(response: Response): Promise<ApiError> {
  const retryHeader = response.headers.get('Retry-After');
  const retryAfter = retryHeader !== null && /^\d+$/.test(retryHeader) ? Number(retryHeader) : null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, fields } = parsed.data.error;
    return new ApiError(response.status, code, message, fields, retryAfter);
  }
  return new ApiError(
    response.status,
    'http_error',
    `The request failed with HTTP ${String(response.status)}.`,
    undefined,
    retryAfter,
  );
}

/**
 * Calls the dashboard API on the same origin with the login session cookie.
 * Throws ApiError for HTTP errors, network errors, and responses that fail the schema.
 */
export async function apiRequest<T = undefined>(
  path: string,
  options: RequestOptions<T> = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json' };
  const init: RequestInit = { method, headers, credentials: 'same-origin' };
  if (options.signal) init.signal = options.signal;
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body ?? {});
  }

  let response: Response;
  try {
    response = await fetch(withQuery(path, options.query), init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(0, 'network_error', 'The server cannot be reached. Check your connection.');
  }

  if (!response.ok) throw await toApiError(response);
  if (response.status === 204 || !options.schema) return undefined as T;

  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      'invalid_response',
      'The server sent a response that is not JSON.',
    );
  }
  try {
    return options.schema.parse(data);
  } catch {
    throw new ApiError(
      response.status,
      'invalid_response',
      'The server sent an unexpected response.',
    );
  }
}

/** A text for people from any error. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return 'Something went wrong.';
}

export function isApiError(error: unknown, code?: ClientErrorCode): error is ApiError {
  return error instanceof ApiError && (code === undefined || error.code === code);
}
