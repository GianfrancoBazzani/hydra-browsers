import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import type { SessionResource } from '@hydra/shared';
import { deleteSessionQuietly, HydraApi, startNewSession } from './api.js';
import { E2E } from './env.js';
import { readRunState, STATE_FILES, type RunRole, type RunState } from './run-state.js';
import { attachSessionLogs } from './session-logs.js';

export interface SessionPair {
  a: SessionResource;
  b: SessionResource;
}

interface WorkerFixtures {
  run: RunState;
  adminApi: HydraApi;
  outsiderApi: HydraApi;
  /** Two running sessions of the admin, shared by the tests of one worker. */
  sessionPair: SessionPair;
}

interface TestFixtures {
  /** Opens a page in a new browser context of another user. */
  pageAs: (role: RunRole) => Promise<Page>;
  /** After a failed test, attaches the logs of the session pods (before sessionPair deletes them). */
  sessionLogs: void;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  run: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      await use(readRunState());
    },
    { scope: 'worker' },
  ],
  adminApi: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const api = await HydraApi.create(STATE_FILES.admin);
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  outsiderApi: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const api = await HydraApi.create(STATE_FILES.outsider);
      await use(api);
      await api.dispose();
    },
    { scope: 'worker' },
  ],
  sessionPair: [
    async ({ adminApi, run }, use) => {
      const settings = { allowlist: [E2E.testsite.host], screen: '1280x720' as const };
      const [a, b] = await Promise.all([
        startNewSession(adminApi, { name: `e2e-a-${run.runId}`, ...settings }),
        startNewSession(adminApi, { name: `e2e-b-${run.runId}`, ...settings }),
      ]);
      await use({ a, b });
      await deleteSessionQuietly(adminApi, a);
      await deleteSessionQuietly(adminApi, b);
    },
    { scope: 'worker', timeout: 300_000 },
  ],
  pageAs: async ({ browser }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (role) => {
      const context = await browser.newContext({ storageState: STATE_FILES[role] });
      contexts.push(context);
      return context.newPage();
    });
    for (const context of contexts) {
      await context.close();
    }
  },
  sessionLogs: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      await use();
      if (testInfo.status !== testInfo.expectedStatus) {
        await attachSessionLogs(testInfo);
      }
    },
    { auto: true, timeout: 120_000 },
  ],
});

export { expect };
