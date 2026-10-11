import { defaultClientConditions, defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Tests run on the TypeScript source of workspace packages (export condition @hydra/source).
  resolve: { conditions: ['@hydra/source', ...defaultClientConditions] },
  ssr: { resolve: { conditions: ['@hydra/source', ...defaultServerConditions] } },
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
