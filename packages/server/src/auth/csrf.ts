import type { IncomingHttpHeaders } from 'node:http';
import { HydraError } from '../lib/errors.js';

/**
 * CSRF check of spec section 6.4 for a request that is not GET or HEAD: the Origin header must be
 * equal to HYDRA_PUBLIC_URL and the Content-Type must be application/json. The JSON body part is
 * checked by the body parser: `api/errors.ts` turns an empty or broken JSON body into csrf_failed.
 */
export function checkCsrf(
  request: { method: string; headers: IncomingHttpHeaders },
  publicOrigin: string,
): void {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  const contentType = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (request.headers.origin !== publicOrigin || contentType !== 'application/json') {
    throw new HydraError('csrf_failed', 'The request failed the CSRF check.');
  }
}
