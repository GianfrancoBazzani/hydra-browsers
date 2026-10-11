import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { HydraError } from '../lib/errors.js';

/** Vite puts hashed file names under assets/, so these files can be cached for a long time. */
function cacheControl(path: string): string {
  return /[\\/]assets[\\/]/.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache';
}

/**
 * The path the router matched: without the query string, percent-decoded (`/%61pi` is `/api`),
 * and without repeated slashes at the start (`//api` is `/api`).
 */
function normalizedPath(url: string): string {
  const raw = url.split('?')[0] ?? '/';
  let path = raw;
  try {
    path = decodeURIComponent(raw);
  } catch {
    // Malformed escape: keep the raw path.
  }
  return path.replace(/^\/+/, '/');
}

/**
 * Serves the @hydra/web build from `root` on the public host scope (the scope adds the host
 * constraint and the headers of spec section 6.8). @fastify/static does the file handling:
 * path traversal checks, ETag and Last-Modified, 304, HEAD, Range, and MIME types.
 * Other GET paths that are not files get index.html (single-page app). Unknown /api paths and
 * paths with a file extension get 404.
 */
export function registerStatic(scope: FastifyInstance, options: { root: string }): void {
  void scope.register(fastifyStatic, {
    root: options.root,
    wildcard: false,
    index: false,
    serveDotFiles: false,
    setHeaders: (reply, path) => {
      reply.header('cache-control', cacheControl(path));
    },
  });

  scope.get('/*', (request, reply) => {
    const path = normalizedPath(request.url);
    if (path === '/api' || path.startsWith('/api/') || /\.[A-Za-z0-9]+$/.test(path)) {
      throw new HydraError('not_found', 'Not found.');
    }
    return reply.sendFile('index.html');
  });
}
