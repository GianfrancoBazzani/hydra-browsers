import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessService } from './access/index.js';
import { buildApp, type AppDeps } from './app.js';
import { AuditWriter, runAuditRetention } from './audit/index.js';
import { AuthService } from './auth/index.js';
import { ConfigError, loadConfig, type Config } from './config/index.js';
import { PasswordHasher, deriveSubkeys } from './crypto/index.js';
import { openDb } from './db/index.js';
import { EventBus } from './events/index.js';
import { systemClock } from './lib/clock.js';
import { withDeadline } from './lib/deadline.js';
import { createLogger, type Logger } from './lib/logger.js';
import {
  attachLiveUpgrade,
  LIVE_SHUTDOWN_GRACE_MS,
  LiveService,
  startLiveConnectionCheck,
} from './live-proxy/index.js';
import {
  checkMediaPortRange,
  createKubeClient,
  MediaPortRangeError,
} from './orchestrator/index.js';
import {
  ActivityTracker,
  scheduleMcpStreamShutdown,
  startMcpConnectionCheck,
  StreamRegistry,
} from './mcp-proxy/index.js';
import { createSessionDeps } from './sessions/index.js';
import { TokensService } from './tokens/index.js';
import { UsersService } from './users/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Spec section 14: open streams and WebSockets get 10 s after SIGTERM, then they are closed. */
const SHUTDOWN_GRACE_MS = 10_000;
/** Each stop step of the shutdown (reconciler, pod endpoints) waits at most this long. */
const SHUTDOWN_STEP_DEADLINE_MS = 5_000;

function readConfig(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`hydra: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/**
 * The dashboard build is the output folder of @hydra/web, next to the server package:
 * `packages/web/dist/` from `packages/server/src/main.ts` and from `packages/server/dist/main.js`.
 * The gateway image keeps this layout (`/app/packages/web/dist`, plan 08).
 */
function findWebRoot(logger: Logger): string | null {
  const root = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  if (existsSync(join(root, 'index.html'))) return root;
  logger.warn({ root }, 'no dashboard build found, the gateway serves only the API');
  return null;
}

async function main(): Promise<void> {
  const config = readConfig();
  const logger = createLogger(config.logLevel);
  const clock = systemClock;
  const database = await openDb({ dataDir: config.dataDir, logger, clock });
  const db = database.db;
  const bus = new EventBus(logger);
  const subkeys = deriveSubkeys(config.secretKey);
  const audit = new AuditWriter({ db, bus, clock });
  const hasher = new PasswordHasher(subkeys.passwordPepper);
  const access = new AccessService({ db, clock, audit, bus });
  const tokens = new TokensService({ db, clock, subkeys, access, audit, bus });
  const auth = new AuthService({ db, clock, subkeys, hasher, audit, bus });
  const users = new UsersService({ db, clock, hasher, auth, tokens, audit, bus });
  // Plan 04: Kubernetes client, startup check of HYDRA_MEDIA_PORT_RANGE (spec section 4), session deps.
  const kube = createKubeClient(config);
  try {
    await checkMediaPortRange({ kube, config, logger });
  } catch (error) {
    if (error instanceof MediaPortRangeError) {
      logger.fatal({ variable: error.variable }, error.message);
      process.exit(1);
    }
    throw error;
  }
  // Plan 05: the agent activity summary (spec section 8.5) and the MCP stream registry (spec section 8.3).
  const activity = new ActivityTracker({ bus, clock });
  activity.start();
  const mcpStreams = new StreamRegistry();
  const sessionDeps = createSessionDeps({
    config,
    clock,
    logger,
    db,
    bus,
    subkeys,
    audit,
    access,
    tokens,
    kube,
    activity,
  });
  const live = new LiveService({ config, clock, logger, db, bus, subkeys, audit, access }); // plan 06
  // Index 5.9: the AppDeps object is named `deps`. Plans 04 to 06 add their fields at the end and
  // pass `deps` to their jobs.
  const deps: AppDeps = {
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
    webRoot: findWebRoot(logger),
    ...sessionDeps,
    activity,
    mcpStreams,
    live,
  };
  const app = await buildApp(deps);
  attachLiveUpgrade(app.server, deps); // plan 06

  // Spec section 13.3: every day, audit retention and the cleanup of expired login sessions and live grants.
  const runDailyJobs = (): void => {
    try {
      const deleted = runAuditRetention({ db, clock }, config.auditRetentionDays);
      logger.info({ deleted }, 'audit retention done');
    } catch (err) {
      logger.error({ err }, 'audit retention failed');
    }
    try {
      logger.info(auth.cleanupExpired(), 'expired login sessions and live grants removed');
    } catch (err) {
      logger.error({ err }, 'cleanup of expired login sessions failed');
    }
  };
  runDailyJobs();
  const daily = setInterval(runDailyJobs, DAY_MS);
  daily.unref();

  // The signal handlers come before the first reconciler pass: a SIGTERM during the pass must
  // drain the server and close the database (the pass can take a while).
  // Set after the first reconciler pass; a SIGTERM before that has nothing to stop.
  let stopMcpConnectionCheck: () => void = () => {};
  let stopLiveConnectionCheck: () => void = () => {};
  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(daily);
    // app.close() stops new requests and waits for open ones; after 10 s it closes them.
    const force = setTimeout(() => {
      logger.warn('closing the open connections');
      app.server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    // Plans 05 and 06 stop their jobs and start their 10 s close timers here (index 5.9).
    activity.stop(); // plan 05
    stopMcpConnectionCheck(); // plan 05
    scheduleMcpStreamShutdown(deps); // plan 05, spec section 14: closes the open MCP streams after 10 s
    // Plan 06: spec section 14, the open WebSockets get 10 s, then they close. The grants stay in
    // the DB, so the live view continues after the restart.
    stopLiveConnectionCheck();
    const closeLiveSockets = setTimeout(() => {
      const closed = deps.live.closeAll('shutdown');
      logger.info({ closed }, 'closed the live WebSockets');
    }, LIVE_SHUTDOWN_GRACE_MS);
    closeLiveSockets.unref();
    try {
      await app.close();
    } finally {
      clearTimeout(force);
      // Plan 04: stop the watches and the port-forward listeners. A failure must not skip the rest.
      // The reconciler may still be in its first pass (stop during start is safe). A step that
      // hangs is left after its deadline, so the database is always closed.
      try {
        await withDeadline(
          deps.reconciler.stop(),
          SHUTDOWN_STEP_DEADLINE_MS,
          'stopping the reconciler',
          logger,
        );
      } catch (err) {
        logger.error({ err }, 'stopping the reconciler failed');
      }
      try {
        await withDeadline(
          deps.podEndpoints.close(),
          SHUTDOWN_STEP_DEADLINE_MS,
          'closing the pod endpoints',
          logger,
        );
      } catch (err) {
        logger.error({ err }, 'closing the pod endpoints failed');
      }
      database.close();
      logger.info('stopped');
    }
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    shutdown(signal).catch((err: unknown) => {
      logger.error({ err }, 'shutdown failed');
      process.exitCode = 1;
    });
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  await app.listen({ port: config.port, host: '0.0.0.0' });
  // Plan 04: first pass, watch, every 30 s (spec sections 7.9 and 14).
  await deps.reconciler.start();
  // Plans 05 and 06 start their connection checks here (index 5.9).
  // A SIGTERM during the first pass has already run shutdown: the interval must not start after it.
  if (!stopping) stopMcpConnectionCheck = startMcpConnectionCheck(deps); // plan 05
  if (!stopping) stopLiveConnectionCheck = startLiveConnectionCheck(deps); // plan 06
}

await main();
