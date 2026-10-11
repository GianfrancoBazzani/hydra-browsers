// When the gateway closes MCP streams (spec section 8.3).
import type { AppDeps } from '../app.js';
import type { EventBus } from '../events/index.js';
import type { Logger } from '../lib/logger.js';
import type { TokensService } from '../tokens/index.js';
import type { StreamRegistry } from './stream-registry.js';

export interface CloserDeps {
  bus: EventBus;
  tokens: Pick<TokensService, 'isValid'>;
  mcpStreams: StreamRegistry;
}

/** Subscribes to the bus events that close MCP streams. Returns the unsubscribe function. */
export function subscribeStreamClosers(deps: CloserDeps): () => void {
  const unsubscribes = [
    deps.bus.subscribe('token.revoked', (event) => {
      deps.mcpStreams.closeWhere((entry) => entry.tokenId === event.tokenId, 'token revoked');
    }),
    deps.bus.subscribe('session.state', (event) => {
      if (event.state === 'starting' || event.state === 'running') return;
      deps.mcpStreams.closeWhere(
        (entry) => entry.sessionId === event.sessionId,
        `session ${event.state}`,
      );
    }),
    deps.bus.subscribe('rights.changed', (event) => {
      deps.mcpStreams.closeWhere(
        (entry) => entry.userId === event.userId && !deps.tokens.isValid(entry.tokenId),
        'rights changed',
      );
    }),
  ];
  return () => {
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** One pass of the connection check: closes the MCP streams of tokens that are not valid now. */
export function runMcpConnectionCheck(deps: Pick<CloserDeps, 'tokens' | 'mcpStreams'>): number {
  const valid = new Map<string, boolean>();
  return deps.mcpStreams.closeWhere((entry) => {
    let ok = valid.get(entry.tokenId);
    if (ok === undefined) {
      ok = deps.tokens.isValid(entry.tokenId);
      valid.set(entry.tokenId, ok);
    }
    return !ok;
  }, 'token no longer valid');
}

export const MCP_CONNECTION_CHECK_MS = 60_000;

/** Runs the connection check every 60 s. Returns the stop function. */
export function startMcpConnectionCheck(deps: AppDeps): () => void {
  const timer = setInterval(() => {
    try {
      const closed = runMcpConnectionCheck(deps);
      if (closed > 0) deps.logger.info({ closed }, 'mcp connection check closed streams');
    } catch (err) {
      deps.logger.error({ err }, 'mcp connection check failed');
    }
  }, MCP_CONNECTION_CHECK_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/** Spec section 14: on SIGTERM, the open MCP streams get 10 s before the gateway closes them. */
export const MCP_SHUTDOWN_GRACE_MS = 10_000;

/** Closes all MCP streams after the grace time. Returns a function that cancels the timer. */
export function scheduleMcpStreamShutdown(
  deps: { mcpStreams: StreamRegistry; logger: Logger },
  graceMs: number = MCP_SHUTDOWN_GRACE_MS,
): () => void {
  const timer = setTimeout(() => {
    const closed = deps.mcpStreams.closeWhere(() => true, 'gateway shutting down');
    deps.logger.info({ closed }, 'closed the open MCP streams for the shutdown');
  }, graceMs);
  timer.unref();
  return () => {
    clearTimeout(timer);
  };
}
