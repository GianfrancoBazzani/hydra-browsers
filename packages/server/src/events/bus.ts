import type { AgentActivity, AuditEvent, SessionState } from '@hydra/shared';
import type { Logger } from '../lib/logger.js';

/** Events of spec section 3.1. The module that causes an event publishes it. */
export type HydraEvent =
  | {
      type: 'session.state';
      sessionId: string;
      state: SessionState;
      previous: SessionState;
      errorReason: string | null;
    }
  | { type: 'session.activity'; sessionId: string; agentActivity: AgentActivity }
  | { type: 'token.revoked'; tokenId: string; sessionId: string }
  | { type: 'rights.changed'; userId: string }
  | { type: 'login.ended'; userId: string; loginSessionIds: string[] }
  | { type: 'audit'; event: AuditEvent };

export type HydraEventType = HydraEvent['type'];
type Handler<T extends HydraEventType> = (event: Extract<HydraEvent, { type: T }>) => void;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

/** In-process event bus. Handlers run synchronously, in the order of subscription. */
export class EventBus {
  readonly #logger: Logger;
  readonly #handlers = new Map<HydraEventType, Set<(event: HydraEvent) => void>>();

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /** Calls each handler of the event type. A handler error (thrown, or the rejection of an async handler) is logged, not thrown. */
  publish(event: HydraEvent): void {
    const handlers = this.#handlers.get(event.type);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        // A handler is typed as sync, but an async one returns a promise: catch its rejection too.
        const result: unknown = handler(event);
        if (isThenable(result)) {
          result.then(undefined, (error: unknown) => {
            this.#logFailure(error, event);
          });
        }
      } catch (error) {
        this.#logFailure(error, event);
      }
    }
  }

  #logFailure(error: unknown, event: HydraEvent): void {
    this.#logger.error({ err: error, eventType: event.type }, 'event handler failed');
  }

  /** Returns the function that removes the subscription. */
  subscribe<T extends HydraEventType>(type: T, handler: Handler<T>): () => void {
    const wrapped = handler as (event: HydraEvent) => void;
    let handlers = this.#handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.#handlers.set(type, handlers);
    }
    handlers.add(wrapped);
    return () => {
      this.#handlers.get(type)?.delete(wrapped);
    };
  }
}
