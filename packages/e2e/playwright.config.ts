import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { E2E } from './src/env.js';
import { STATE_FILES } from './src/run-state.js';

/**
 * E2E tests on the k3d cluster of scripts/dev-cluster.sh (spec section 15.3).
 * One worker: the tests share one cluster, one gateway, and the HYDRA_MAX_RUNNING capacity.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 5 * 60_000,
  // Below the job limits of .github/workflows (60 min for e2e and e2e-long, 90 min for nightly, with
  // the image build before the tests): Playwright stops first, so the report is written. A full run
  // takes about 3 min, and the long stream test about 12 min.
  globalTimeout: 35 * 60_000,
  expect: { timeout: 15_000 },
  // Outside the repository, so that git, Prettier, and ESLint never see the generated files.
  outputDir: join(E2E.outputDir, 'test-results'),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: join(E2E.outputDir, 'playwright-report') }],
  ],
  use: {
    baseURL: E2E.publicUrl,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Neko starts the video without a click. No executablePath and no channel: this package uses
    // only the Chromium of its own @playwright/test (@playwright/mcp in @hydra/mcp-sidecar pulls
    // another Playwright version with another Chromium revision, which tests must not pick up).
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
  },
  projects: [
    { name: 'setup', testMatch: /global\.setup\.ts/ },
    {
      name: 'e2e',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['setup'],
      use: { storageState: STATE_FILES.admin },
    },
  ],
});
