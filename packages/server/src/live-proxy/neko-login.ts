import type { NekoProfile } from '@hydra/shared';
import { nekoPassword, type Subkeys } from '../crypto/index.js';
import type { LiveGrant } from './types.js';

/** What a strategy changes in a request to the pod. */
export interface UpstreamPatch {
  /** Query values to set. They replace the values that the browser sent. */
  query: Record<string, string>;
  /** Headers to set. */
  headers: Record<string, string>;
}

export interface NekoLoginInput {
  grant: LiveGrant;
  /** The current Hydra display name of the grant user. */
  displayName: string;
  /** Neko in the pod, as 'http://host:port' (podEndpoint(sid, 8080)). */
  endpoint: string;
}

/**
 * How the gateway logs the browser in to Neko (spec section 9.2 steps 4 and 5). This file is the
 * only place that changes when spike S2 or S3 fails (index section 6).
 *
 * - `queryRewrite` (main path, spec section 9.2 step 4). Verified in Neko v3.1.6: the legacy
 *   client opens `<location.pathname>/ws?password=…&username=…` (client/src/neko/index.ts and
 *   base.ts). The legacy handler (`GET /ws`, on by default: flag `legacy`, default true) reads the
 *   query values `username` and `password` and calls its own `POST /api/login`
 *   (server/internal/http/legacy/handler.go and session.go). The gateway replaces both values.
 *   HTTP requests need no login.
 * - `serverLogin` (fallback, spec section 9.2 step 5). Plan 09 adds it here only if spike S2
 *   fails. The legacy handler first calls `/api/whoami` with the Cookie header of the upgrade
 *   request and keeps that Neko session if it is valid (session.go `create()`). Neko reads a
 *   session cookie only with `NEKO_SESSION_COOKIE_ENABLED=true` (server/internal/session/auth.go
 *   `getToken()`, default false), and then `POST /api/login` returns the token in the
 *   `NEKO_SESSION` Set-Cookie header, not in the JSON body (server/internal/api/session.go
 *   `Login()`). So serverLogin sets `NEKO_SESSION_COOKIE_ENABLED=true` in the pod environment
 *   (orchestrator/manifests/neko-env.ts), logs in from the gateway with the Neko password of the
 *   profile, keeps the token per grant in memory, and sends `Cookie: NEKO_SESSION=<token>` with
 *   each HTTP request and upgrade to the pod. `forget()` drops the token. The browser never gets
 *   the token, because the proxy removes Set-Cookie.
 */
export interface NekoLoginStrategy {
  readonly name: 'queryRewrite' | 'serverLogin';
  /** Changes for a WebSocket upgrade request to the pod. */
  forUpgrade(input: NekoLoginInput): Promise<UpstreamPatch>;
  /** Changes for a proxied HTTP request to the pod. */
  forHttp(input: NekoLoginInput): Promise<UpstreamPatch>;
  /** The grant ended. Drop the state that the strategy keeps for it. */
  forget(grantId: string): void;
}

/**
 * The Neko user name of a person. Main path: the Hydra display name (spec section 9.2 step 4).
 * Spike S3 fallback (spec section 6.7): the fixed user of the Neko profile (`hydra-admin` or
 * `hydra-viewer`).
 */
export function nekoUsername(_profile: NekoProfile, displayName: string): string {
  return displayName;
}

export function createQueryRewriteStrategy(subkeys: Pick<Subkeys, 'neko'>): NekoLoginStrategy {
  return {
    name: 'queryRewrite',
    forUpgrade: ({ grant, displayName }) =>
      Promise.resolve({
        query: {
          username: nekoUsername(grant.nekoProfile, displayName),
          password: nekoPassword(subkeys.neko, grant.sessionId, grant.nekoProfile),
        },
        headers: {},
      }),
    forHttp: () => Promise.resolve({ query: {}, headers: {} }),
    forget: () => {},
  };
}

/** The strategy of the gateway. Plan 09 returns `serverLogin` here only if spike S2 fails. */
export function createNekoLoginStrategy(deps: {
  subkeys: Pick<Subkeys, 'neko'>;
}): NekoLoginStrategy {
  return createQueryRewriteStrategy(deps.subkeys);
}
