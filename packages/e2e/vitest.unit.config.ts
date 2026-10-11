import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Unit tests of the e2e helpers (no cluster). The name is not vitest.config.ts, so the root
// projects of `pnpm test` do not include it (plan 01). The Playwright specs in tests/ need k3d.
export default defineConfig({
  // Tests run on the TypeScript source of workspace packages (export condition @hydra/source).
  ssr: { resolve: { conditions: ['@hydra/source', ...defaultServerConditions] } },
  test: {
    name: 'e2e-unit',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
