import type { AccessService } from '../access/index.js';
import type { AuditWriter } from '../audit/index.js';
import type { Config } from '../config/index.js';
import type { Subkeys } from '../crypto/index.js';
import type { Db } from '../db/index.js';
import type { EventBus } from '../events/index.js';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import {
  createPodEndpointResolver,
  type PodEndpointResolver,
} from '../orchestrator/pod-endpoint.js';
import { Reconciler } from '../orchestrator/reconciler.js';
import type { KubeClient } from '../orchestrator/types.js';
import type { TokensService } from '../tokens/index.js';
import type { ActivityProvider } from './activity.js';
import { SessionsService } from './service.js';

export interface SessionDepsInput {
  config: Config;
  clock: Clock;
  logger: Logger;
  db: Db;
  bus: EventBus;
  subkeys: Subkeys;
  audit: AuditWriter;
  access: AccessService;
  tokens: TokensService;
  kube: KubeClient;
  activity: ActivityProvider;
  /** Use this reconciler instead of building one (tests). */
  reconciler?: Reconciler;
  /** Use this resolver instead of building one (tests). */
  podEndpoints?: PodEndpointResolver;
}

/** The AppDeps fields of plan 04. main.ts and createTestApp call this one function. */
export interface SessionDeps {
  kube: KubeClient;
  podEndpoints: PodEndpointResolver;
  reconciler: Reconciler;
  sessions: SessionsService;
  activity: ActivityProvider;
}

export function createSessionDeps(input: SessionDepsInput): SessionDeps {
  const { config, clock, logger, db, bus, subkeys, audit, access, tokens, kube, activity } = input;
  const reconciler =
    input.reconciler ?? new Reconciler({ db, kube, config, subkeys, clock, logger, audit, bus });
  const podEndpoints = input.podEndpoints ?? createPodEndpointResolver(config, kube, logger);
  const sessions = new SessionsService({
    db,
    config,
    clock,
    audit,
    access,
    tokens,
    kube,
    reconciler,
    activity,
  });
  return { kube, podEndpoints, reconciler, sessions, activity };
}
