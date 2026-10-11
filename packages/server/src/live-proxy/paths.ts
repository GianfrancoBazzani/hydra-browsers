/** A request path on the live host: /s/<sid><path>?<search>. */
export interface LivePath {
  sessionId: string;
  /** The path without the /s/<sid> prefix. It starts with "/". */
  path: string;
  /** The raw query string without "?", or "". */
  search: string;
}

// sid: 12 characters of [a-z2-7] (spec section 7.1).
const LIVE_PATH = /^\/s\/([a-z2-7]{12})(\/[^?]*)(?:\?(.*))?$/;

/** Parses the raw request URL (origin-form) of a live host request. Returns null for other URLs. */
export function parseLivePath(url: string): LivePath | null {
  const match = LIVE_PATH.exec(url);
  if (match === null) return null;
  const [, sessionId = '', path = '/', search = ''] = match;
  return { sessionId, path, search };
}

/** The upstream path: the path without the prefix, and the query with the given values set. */
export function upstreamPathOf(target: LivePath, set: Record<string, string>): string {
  if (Object.keys(set).length === 0) {
    return target.search === '' ? target.path : `${target.path}?${target.search}`;
  }
  const query = new URLSearchParams(target.search);
  for (const [name, value] of Object.entries(set)) query.set(name, value);
  return `${target.path}?${query.toString()}`;
}
