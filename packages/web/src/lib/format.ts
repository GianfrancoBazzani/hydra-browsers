import type { AgentActivity } from '@hydra/shared';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const timeWithSeconds = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'short',
  timeStyle: 'medium',
});

/** A date and time in the local format, or "Never". */
export function formatDateTime(ms: number | null): string {
  return ms === null ? 'Never' : dateTime.format(ms);
}

/** A date and time with seconds (Activity view). */
export function formatEventTime(ms: number): string {
  return timeWithSeconds.format(ms);
}

/** For example "browser_click · ok · 230 ms" (spec section 10.2). */
export function formatToolCall(call: NonNullable<AgentActivity['lastToolCall']>): string {
  const parts = [call.tool, call.status];
  if (call.durationMs !== null) parts.push(`${String(Math.round(call.durationMs))} ms`);
  return parts.join(' · ');
}

export function formatAgentCount(count: number): string {
  if (count === 0) return 'No agent connected';
  return count === 1 ? '1 agent connected' : `${String(count)} agents connected`;
}

/** True when the allowlist permits all domains (spec section 7.2). */
export function permitsAllDomains(allowlist: readonly string[]): boolean {
  return allowlist.length === 1 && allowlist[0] === '*';
}
