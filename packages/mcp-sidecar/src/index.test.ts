import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

describe('@hydra/mcp-sidecar', () => {
  it('installs @playwright/mcp 0.0.83 with the playwright-mcp command', () => {
    const manifest = require('@playwright/mcp/package.json') as {
      version: string;
      bin: Record<string, string>;
    };
    expect(manifest.version).toBe('0.0.83');
    expect(manifest.bin).toHaveProperty('playwright-mcp');
  });
});
