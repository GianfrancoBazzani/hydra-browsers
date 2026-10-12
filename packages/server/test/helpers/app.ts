import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { ApiError } from '@hydra/shared';
import { AccessService } from '../../src/access/index.js';
import { buildApp, type AppDeps } from '../../src/app.js';
import { AuditWriter } from '../../src/audit/index.js';
import { AuthService } from '../../src/auth/index.js';
import { PasswordHasher, deriveSubkeys } from '../../src/crypto/index.js';
import { EventBus } from '../../src/events/index.js';
import { createLogger } from '../../src/lib/logger.js';
import { LiveService } from '../../src/live-proxy/index.js';
import { ActivityTracker, StreamRegistry } from '../../src/mcp-proxy/index.js';
import { createSessionDeps } from '../../src/sessions/index.js';
import { TokensService } from '../../src/tokens/index.js';
import { UsersService } from '../../src/users/index.js';
import { VaultService } from '../../src/vault/index.js';
import { FakeClock } from './clock.js';
import { testConfig } from './config.js';
import { createTestDb } from './db.js';
import { FakeKubeClient } from './fake-kube.js';

export const TEST_START = Date.UTC(2026, 9, 10, 12, 0, 0);
/** testConfig(): public URL http://hydra.localhost, live URL http://live.hydra.localhost. */
export const PUBLIC_HOST = 'hydra.localhost';
export const PUBLIC_ORIGIN = 'http://hydra.localhost';
export const LIVE_HOST = 'live.hydra.localhost';

/** Real SQLite in a temporary folder, a FakeClock, and the real services (index section 5.12). */
export async function createTestApp(overrides: Partial<AppDeps> = {}): Promise<{
  app: FastifyInstance;
  deps: AppDeps;
  clock: FakeClock;
  close(): Promise<void>;
}> {
  const clock = overrides.clock instanceof FakeClock ? overrides.clock : new FakeClock(TEST_START);
  const config = overrides.config ?? testConfig();
  const testDb = createTestDb(clock);
  const db = overrides.db ?? testDb.db;
  const logger = overrides.logger ?? createLogger('fatal');
  const bus = overrides.bus ?? new EventBus(logger);
  const subkeys = overrides.subkeys ?? deriveSubkeys(config.secretKey);
  const audit = overrides.audit ?? new AuditWriter({ db, bus, clock });
  const hasher = overrides.hasher ?? new PasswordHasher(subkeys.passwordPepper);
  const access = overrides.access ?? new AccessService({ db, clock, audit, bus });
  const tokens = overrides.tokens ?? new TokensService({ db, clock, subkeys, access, audit, bus });
  const auth = overrides.auth ?? new AuthService({ db, clock, subkeys, hasher, audit, bus });
  const users =
    overrides.users ?? new UsersService({ db, clock, hasher, auth, tokens, audit, bus });
  // The deps of plans 02 and 03. Plans 04 to 06 build their deps from `base` and replace the
  // `deps` line below; `...overrides` stays last (index 5.12).
  const base = {
    config,
    clock,
    logger,
    db,
    bus,
    subkeys,
    audit,
    hasher,
    auth,
    users,
    access,
    tokens,
    webRoot: overrides.webRoot ?? null,
  };
  // Plan 05: the agent activity summary and the MCP stream registry (a test can pass its own).
  const activity = overrides.activity ?? new ActivityTracker({ bus: base.bus, clock: base.clock });
  activity.start();
  const mcpStreams = overrides.mcpStreams ?? new StreamRegistry();
  // Plan 04: the session deps. A test can pass its own kube (a FakeKubeClient) or activity.
  const sessionDeps = createSessionDeps({
    config: base.config,
    clock: base.clock,
    logger: base.logger,
    db: base.db,
    bus: base.bus,
    subkeys: base.subkeys,
    audit: base.audit,
    access: base.access,
    tokens: base.tokens,
    kube: overrides.kube ?? new FakeKubeClient(base.config.sessionNamespace),
    activity,
    ...(overrides.reconciler !== undefined ? { reconciler: overrides.reconciler } : {}),
    ...(overrides.podEndpoints !== undefined ? { podEndpoints: overrides.podEndpoints } : {}),
  });
  // Plan 06: the live service (a test can pass its own).
  const live =
    overrides.live ??
    new LiveService({
      config: base.config,
      clock: base.clock,
      logger: base.logger,
      db: base.db,
      bus: base.bus,
      subkeys: base.subkeys,
      audit: base.audit,
      access: base.access,
    });
  // Secrets vault (spec section 6.9; a test can pass its own).
  const vault =
    overrides.vault ??
    new VaultService({
      db: base.db,
      clock: base.clock,
      subkeys: base.subkeys,
      config: base.config,
      audit: base.audit,
      bus: base.bus,
    });
  vault.start();
  const deps: AppDeps = {
    ...base,
    ...sessionDeps,
    activity,
    mcpStreams,
    live,
    vault,
    ...overrides,
  };
  const app = await buildApp(deps);
  await app.ready();
  return {
    app,
    deps,
    clock,
    close: async () => {
      deps.mcpStreams.closeWhere(() => true, 'test app closed'); // plan 05
      deps.activity.stop(); // plan 05
      deps.vault.stop();
      await deps.reconciler.stop(); // plan 04
      await deps.podEndpoints.close(); // plan 04
      deps.live.closeAll('test finished'); // plan 06
      await app.close();
      deps.live.dispose(); // plan 06
      testDb.close();
    },
  };
}

export interface ApiRequest {
  method: 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  /** The `cookie` header value, for example from `loginAs`. */
  cookie?: string;
  /** JSON body. Requests that are not GET/HEAD send `{}` if it is missing, as the dashboard does. */
  body?: unknown;
  /** Extra headers. They replace the defaults (host, origin, content-type). */
  headers?: Record<string, string>;
  remoteAddress?: string;
}

/** The `error` object of an error response (spec section 12.2). */
export function errorOf(response: LightMyRequestResponse): ApiError['error'] {
  return response.json<ApiError>().error;
}

/** An API request on the public host that passes the CSRF check, as the dashboard sends it. */
export function apiRequest(
  app: FastifyInstance,
  request: ApiRequest,
): Promise<LightMyRequestResponse> {
  const withBody = request.method !== 'GET' && request.method !== 'HEAD';
  const headers: Record<string, string> = { host: PUBLIC_HOST };
  if (request.cookie !== undefined) headers.cookie = request.cookie;
  if (withBody) {
    headers.origin = PUBLIC_ORIGIN;
    headers['content-type'] = 'application/json';
  }
  Object.assign(headers, request.headers);
  return app.inject({
    method: request.method,
    url: request.url,
    headers,
    ...(withBody ? { payload: JSON.stringify(request.body ?? {}) } : {}),
    ...(request.remoteAddress !== undefined ? { remoteAddress: request.remoteAddress } : {}),
  });
}
