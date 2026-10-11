import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { AccessService } from './access/index.js';
import { registerAuditRoutes } from './api/audit.js';
import { registerAuthRoutes } from './api/auth.js';
import { registerEventRoutes } from './api/events.js';
import { errorHandler, frameworkErrorHandler, notFoundHandler } from './api/errors.js';
import { registerHealthRoutes } from './api/health.js';
import { registerLiveTicketRoutes } from './api/live.js';
import { registerMemberRoutes } from './api/members.js';
import { registerSessionRoutes } from './api/sessions.js';
import { closeAllSse } from './api/sse.js';
import { registerTokenRoutes } from './api/tokens.js';
import { registerUserRoutes } from './api/users.js';
import type { AuditWriter } from './audit/index.js';
import { SESSION_COOKIE, checkCsrf, parseCookies, type AuthService } from './auth/index.js';
import type { Config } from './config/index.js';
import type { PasswordHasher, Subkeys } from './crypto/index.js';
import type { Db } from './db/index.js';
import type { EventBus } from './events/index.js';
import type { Clock } from './lib/clock.js';
import type { Logger } from './lib/logger.js';
import { registerLiveHostRoutes, type LiveService } from './live-proxy/index.js';
import { registerMcpRoutes, type ActivityTracker, type StreamRegistry } from './mcp-proxy/index.js';
import type { PodEndpointResolver } from './orchestrator/pod-endpoint.js';
import type { Reconciler } from './orchestrator/reconciler.js';
import type { KubeClient } from './orchestrator/types.js';
import type { SessionsService } from './sessions/service.js';
import { SHARED_SECURITY_HEADERS, dashboardHeaders } from './static/headers.js';
import { registerStatic } from './static/index.js';
import type { TokensService } from './tokens/index.js';
import type { UsersService } from './users/index.js';

/** 1 MiB, the body limit of spec section 8.2. Dashboard bodies are much smaller. */
export const BODY_LIMIT = 1_048_576;

export interface AppDeps {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  hasher: PasswordHasher;
  auth: AuthService;
  users: UsersService;
  access: AccessService;
  tokens: TokensService;
  /** Folder of the @hydra/web build, or null to serve no dashboard (development, tests). */
  webRoot: string | null;
  // Plan 04
  kube: KubeClient;
  podEndpoints: PodEndpointResolver;
  reconciler: Reconciler;
  sessions: SessionsService;
  activity: ActivityTracker; // plan 05: replaces the plan 04 type ActivityProvider (the tracker implements it)
  // Plan 05
  mcpStreams: StreamRegistry;
  // Plan 06
  live: LiveService;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  // Widen the pino type, so the instance is a plain FastifyInstance for all plans.
  const loggerInstance: FastifyBaseLogger = deps.logger;
  const app = Fastify({
    loggerInstance,
    trustProxy: config.trustedProxies,
    bodyLimit: BODY_LIMIT,
    frameworkErrors: frameworkErrorHandler,
  });
  app.decorateRequest('login', null);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  // app.close() waits for open connections; SSE streams never end by themselves.
  app.addHook('preClose', (done) => {
    closeAllSse(app.server);
    done();
  });

  // Spec 6.8, "Both origins": every response of every host carries these headers, including
  // health, not-found and error responses. Registered at the root, before any route, so it
  // covers all scopes (plan 06 reuses it for the live host). Framework errors run before hooks;
  // frameworkErrorHandler sets the same headers.
  app.addHook('onRequest', (_request, reply, next) => {
    reply.headers(SHARED_SECURITY_HEADERS);
    next();
  });

  registerHealthRoutes(app, deps);

  // Public host: dashboard, API, and (plan 05) the MCP endpoint.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.publicUrl.host };
    });
    const headers = dashboardHeaders(config);
    scope.addHook('onRequest', (request, reply, next) => {
      reply.headers(headers);
      // Use the route pattern: the raw URL can be percent-encoded (`/%61pi/...`).
      if (request.routeOptions.url?.startsWith('/api/')) {
        checkCsrf(request, config.publicUrl.origin);
        request.login = deps.auth.resolve(parseCookies(request.headers.cookie)[SESSION_COOKIE]);
      }
      next();
    });
    registerAuthRoutes(scope, deps);
    registerUserRoutes(scope, deps);
    registerMemberRoutes(scope, deps);
    registerSessionRoutes(scope, deps);
    registerEventRoutes(scope, deps);
    registerTokenRoutes(scope, deps);
    registerAuditRoutes(scope, deps);
    if (deps.webRoot !== null) registerStatic(scope, { root: deps.webRoot });
    registerMcpRoutes(scope, deps); // plan 05
    registerLiveTicketRoutes(scope, deps); // plan 06
    // Plan 06 adds its other route registrations here.
    done();
  });

  // Live host: plan 06 registers the live routes in this scope.
  await app.register((scope, _options, done) => {
    scope.addHook('onRoute', (route) => {
      route.constraints = { ...route.constraints, host: config.liveUrl.host };
    });
    registerLiveHostRoutes(scope, deps); // plan 06
    done();
  });

  return app;
}
