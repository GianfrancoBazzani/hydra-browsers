import { describe, expect, it } from 'vitest';
import { formatAgentCount, formatToolCall, permitsAllDomains } from './format';

describe('format', () => {
  it('formats the last tool call like the spec example', () => {
    expect(
      formatToolCall({ tool: 'browser_click', status: 'ok', durationMs: 230, startedAt: 0 }),
    ).toBe('browser_click · ok · 230 ms');
    expect(
      formatToolCall({ tool: 'browser_type', status: 'pending', durationMs: null, startedAt: 0 }),
    ).toBe('browser_type · pending');
  });

  it('formats the number of connected agents', () => {
    expect(formatAgentCount(0)).toBe('No agent connected');
    expect(formatAgentCount(1)).toBe('1 agent connected');
    expect(formatAgentCount(3)).toBe('3 agents connected');
  });

  it('detects the allow-all allowlist', () => {
    expect(permitsAllDomains(['*'])).toBe(true);
    expect(permitsAllDomains(['example.com'])).toBe(false);
  });
});
