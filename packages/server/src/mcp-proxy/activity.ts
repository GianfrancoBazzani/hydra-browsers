// Agent activity summary for each session, from the mcp.* audit events (spec section 8.5).
import type { AgentActivity, AuditEvent } from '@hydra/shared';
import type { Clock } from '../lib/clock.js';
import type { EventBus } from '../events/index.js';
import type { ActivityProvider } from '../sessions/index.js';

/** An MCP session counts as an active agent for 60 s after its last mcp.* event. */
export const ACTIVITY_WINDOW_MS = 60_000;
/** How often the timer checks for expired values. */
export const SWEEP_INTERVAL_MS = 1_000;

type ToolCallStatus = 'pending' | 'ok' | 'error';

interface LastToolCall {
  auditId: number;
  tool: string;
  status: ToolCallStatus;
  durationMs: number | null;
  startedAt: number;
  changedAt: number;
}

interface SessionActivity {
  agents: Map<string, number>; // mcpSessionId -> time of the last mcp.* event
  last: LastToolCall | null;
  published: string; // JSON of the last summary on the bus
}

const EMPTY: AgentActivity = { activeAgentCount: 0, lastToolCall: null };
const EMPTY_JSON = JSON.stringify(EMPTY);

function isStatus(value: unknown): value is ToolCallStatus {
  return value === 'pending' || value === 'ok' || value === 'error';
}

export class ActivityTracker implements ActivityProvider {
  readonly #bus: EventBus;
  readonly #clock: Clock;
  readonly #sessions = new Map<string, SessionActivity>();
  #unsubscribe: (() => void) | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(deps: { bus: EventBus; clock: Clock }) {
    this.#bus = deps.bus;
    this.#clock = deps.clock;
  }

  /** Subscribes to the audit events and starts the timer for the 60 s decay. */
  start(): void {
    if (this.#unsubscribe !== null) return;
    this.#unsubscribe = this.#bus.subscribe('audit', (event) => {
      this.#record(event.event);
    });
    this.#timer = setInterval(() => {
      this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.#timer.unref();
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  get(sessionId: string): AgentActivity {
    const state = this.#sessions.get(sessionId);
    return state ? this.#summary(state, this.#clock.now()) : { ...EMPTY };
  }

  /** Removes expired values and publishes session.activity for each summary that changed (the timer calls it). */
  sweep(): void {
    const now = this.#clock.now();
    for (const [sessionId, state] of this.#sessions) {
      for (const [mcpSessionId, at] of state.agents) {
        if (now - at >= ACTIVITY_WINDOW_MS) state.agents.delete(mcpSessionId);
      }
      if (state.last !== null && !this.#lastIsVisible(state.last, now)) state.last = null;
      this.#publishIfChanged(sessionId, state, now);
      if (state.agents.size === 0 && state.last === null) this.#sessions.delete(sessionId);
    }
  }

  #record(event: AuditEvent): void {
    if (event.kind !== 'mcp.connect' && event.kind !== 'mcp.tool_call') return;
    if (event.sessionId === null) return;
    const now = this.#clock.now();
    let state = this.#sessions.get(event.sessionId);
    if (state === undefined) {
      state = { agents: new Map(), last: null, published: EMPTY_JSON };
      this.#sessions.set(event.sessionId, state);
    }
    const mcpSessionId = event.data.mcpSessionId;
    if (typeof mcpSessionId === 'string' && mcpSessionId !== '')
      state.agents.set(mcpSessionId, now);
    const tool = event.data.tool;
    if (
      event.kind === 'mcp.tool_call' &&
      typeof tool === 'string' &&
      (state.last === null || event.id >= state.last.auditId)
    ) {
      const durationMs = event.data.durationMs;
      state.last = {
        auditId: event.id,
        tool,
        status: isStatus(event.status) ? event.status : 'pending',
        durationMs: typeof durationMs === 'number' ? durationMs : null,
        startedAt: event.ts,
        changedAt: now,
      };
    }
    this.#publishIfChanged(event.sessionId, state, now);
  }

  #lastIsVisible(last: LastToolCall, now: number): boolean {
    return last.status === 'pending' || now - last.changedAt < ACTIVITY_WINDOW_MS;
  }

  #summary(state: SessionActivity, now: number): AgentActivity {
    let activeAgentCount = 0;
    for (const at of state.agents.values()) if (now - at < ACTIVITY_WINDOW_MS) activeAgentCount++;
    const last = state.last;
    const lastToolCall =
      last !== null && this.#lastIsVisible(last, now)
        ? {
            tool: last.tool,
            status: last.status,
            durationMs: last.durationMs,
            startedAt: last.startedAt,
          }
        : null;
    return { activeAgentCount, lastToolCall };
  }

  #publishIfChanged(sessionId: string, state: SessionActivity, now: number): void {
    const summary = this.#summary(state, now);
    const json = JSON.stringify(summary);
    if (json === state.published) return;
    state.published = json;
    this.#bus.publish({ type: 'session.activity', sessionId, agentActivity: summary });
  }
}
