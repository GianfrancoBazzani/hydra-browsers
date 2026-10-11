import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run on the TypeScript source of workspace packages (export condition @hydra/source).
  ssr: { resolve: { conditions: ['@hydra/source', ...defaultServerConditions] } },
  test: {
    name: 'mcp-sidecar',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
