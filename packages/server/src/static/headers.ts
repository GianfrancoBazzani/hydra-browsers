import type { Config } from '../config/index.js';

/** Spec section 6.8, "Both origins": the headers of every response of the public and live host. */
export const SHARED_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** Spec section 6.8, dashboard origin. Set on every response of the public host. */
export function dashboardHeaders(config: Config): Record<string, string> {
  return {
    'content-security-policy': [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `frame-src ${config.liveUrl.origin}`,
      "img-src 'self' data:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
    ].join('; '),
    ...SHARED_SECURITY_HEADERS,
  };
}
