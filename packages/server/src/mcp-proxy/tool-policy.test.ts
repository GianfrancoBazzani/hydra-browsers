import { describe, expect, it } from 'vitest';
import {
  DENIED_TOOL_ERROR_CODE,
  TOOL_DENY_LIST,
  deniedToolMessage,
  isToolDenied,
} from './tool-policy.js';

describe('TOOL_DENY_LIST', () => {
  it('contains exactly the tools that run code in the MCP server process', () => {
    expect([...TOOL_DENY_LIST].sort()).toEqual(['browser_run_code', 'browser_run_code_unsafe']);
  });

  it('does not block browser_evaluate or other page tools', () => {
    for (const tool of [
      'browser_evaluate',
      'browser_navigate',
      'browser_type',
      'browser_fill_form',
      'browser_click',
    ]) {
      expect(isToolDenied(tool)).toBe(false);
    }
  });

  it('blocks the pinned tool name and compares names exactly', () => {
    expect(isToolDenied('browser_run_code_unsafe')).toBe(true);
    expect(isToolDenied('browser_run_code')).toBe(true);
    expect(isToolDenied('BROWSER_RUN_CODE_UNSAFE')).toBe(false);
  });
});

describe('deniedToolMessage', () => {
  it('uses the invalid params code and names the gateway', () => {
    expect(DENIED_TOOL_ERROR_CODE).toBe(-32602);
    expect(deniedToolMessage('browser_run_code_unsafe')).toContain('blocked by the Hydra gateway');
  });
});
