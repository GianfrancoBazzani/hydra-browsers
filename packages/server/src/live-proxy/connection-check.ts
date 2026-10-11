import { LIVE_CHECK_INTERVAL_MS } from './constants.js';
import type { LiveProxyDeps } from './deps.js';

/**
 * Runs LiveService.checkConnections() every 60 s (spec sections 9.2 and 13.3). Returns the stop
 * function.
 */
export function startLiveConnectionCheck(deps: Pick<LiveProxyDeps, 'live' | 'logger'>): () => void {
  const timer = setInterval(() => {
    try {
      deps.live.checkConnections();
    } catch (error) {
      deps.logger.error({ err: error }, 'live connection check failed');
    }
  }, LIVE_CHECK_INTERVAL_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
