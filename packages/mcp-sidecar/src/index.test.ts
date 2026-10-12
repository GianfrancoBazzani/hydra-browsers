import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('@hydra/mcp-sidecar', () => {
  it('uses @playwright/mcp 0.0.83 and the same playwright version (spec section 3.4.4)', () => {
    const mcp = require('@playwright/mcp/package.json') as {
      version: string;
      dependencies: Record<string, string>;
    };
    const playwright = require('playwright/package.json') as { version: string };
    expect(mcp.version).toBe('0.0.83');
    expect(playwright.version).toBe(mcp.dependencies.playwright);
  });
});
