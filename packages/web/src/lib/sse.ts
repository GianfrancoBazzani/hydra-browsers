import type { QueryClient } from '@tanstack/react-query';
import {
  AuditEventSchema,
  SessionActivityEventSchema,
  SessionStateEventSchema,
} from '@hydra/shared';
import { addAuditEvent, patchSession, removeSession } from '../api/cache';
import { queryKeys } from '../api/keys';

/** Waits before a new connection when the browser gave up (HTTP error answer). */
export const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

export interface EventStreamOptions {
  url: string;
  /** Event name → handler of the parsed JSON data. */
  handlers: Record<string, (data: unknown) => void>;
  /**
   * Runs when the stream is open again after an error, also after the server ended it, for
   * example after a rights change (spec sections 6.5 and 10.3).
   */
  onReconnect?: () => void;
  /** Runs when the browser gave up, before the next try. */
  onGiveUp?: () => void;
}

/**
 * One SSE connection with reconnect. The browser reconnects by itself after a network error.
 * After an HTTP error answer (readyState CLOSED), this class opens a new EventSource with the
 * delays of RETRY_DELAYS_MS.
 */
export class EventStream {
  private readonly options: EventStreamOptions;
  private source: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private hadError = false;
  private stopped = true;

  constructor(options: EventStreamOptions) {
    this.options = options;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
  }

  /** Connects at once if the browser gave up, for example when the window gets the focus. */
  ensureOpen(): void {
    if (this.stopped) return;
    if (this.source && this.source.readyState !== EventSource.CLOSED) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  }

  private connect(): void {
    const source = new EventSource(this.options.url);
    this.source = source;
    source.addEventListener('open', () => {
      this.attempt = 0;
      if (this.hadError) {
        this.hadError = false;
        this.options.onReconnect?.();
      }
    });
    source.addEventListener('error', () => {
      this.hadError = true;
      if (source.readyState === EventSource.CLOSED && this.source === source) this.retryLater();
    });
    for (const [name, handler] of Object.entries(this.options.handlers)) {
      source.addEventListener(name, (event) => {
        let data: unknown;
        try {
          data = JSON.parse((event as MessageEvent<string>).data);
        } catch {
          return;
        }
        handler(data);
      });
    }
  }

  private retryLater(): void {
    this.source?.close();
    this.source = null;
    this.options.onGiveUp?.();
    if (this.stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(this.attempt, RETRY_DELAYS_MS.length - 1)];
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
  }
}

/**
 * GET /api/events: `session.state` and `session.activity` of all sessions that the user can read.
 * It updates the session caches. After a reconnect it fetches the session data again. The gateway
 * ends this stream after a rights change of the user, so the refetch gives the new rights (6.5).
 */
export function createUserEventStream(
  queryClient: QueryClient,
  callbacks: { onReconnect: () => void },
): EventStream {
  return new EventStream({
    url: '/api/events',
    handlers: {
      'session.state': (data) => {
        const parsed = SessionStateEventSchema.safeParse(data);
        if (!parsed.success) return;
        const { sessionId, state, errorReason } = parsed.data;
        if (state === 'deleted') {
          removeSession(queryClient, sessionId);
          return;
        }
        const found = patchSession(queryClient, sessionId, { state, errorReason });
        if (!found) void queryClient.invalidateQueries({ queryKey: queryKeys.sessionLists });
        // restartRequired can change with the state.
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) });
      },
      'session.activity': (data) => {
        const parsed = SessionActivityEventSchema.safeParse(data);
        if (!parsed.success) return;
        patchSession(queryClient, parsed.data.sessionId, {
          agentActivity: parsed.data.agentActivity,
        });
      },
    },
    onReconnect: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      callbacks.onReconnect();
    },
    onGiveUp: () => {
      // A 401 means that the login ended. Loading the user again shows the Login screen.
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}

/** GET /api/sessions/<sid>/events: audit events for the Activity view (right `audit.read`). */
export function createSessionEventStream(queryClient: QueryClient, sid: string): EventStream {
  return new EventStream({
    url: `/api/sessions/${sid}/events`,
    handlers: {
      audit: (data) => {
        const parsed = AuditEventSchema.safeParse(data);
        if (parsed.success) addAuditEvent(queryClient, sid, parsed.data);
      },
    },
    onReconnect: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.auditAll(sid) });
    },
  });
}
