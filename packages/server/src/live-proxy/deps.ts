import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { PodEndpointResolver } from '../orchestrator/index.js';
import type { LiveService } from './live-service.js';

/** The part of AppDeps that the live proxy uses. AppDeps (src/app.ts) satisfies it. */
export interface LiveProxyDeps {
  config: Config;
  logger: Logger;
  live: LiveService;
  podEndpoints: PodEndpointResolver;
}
