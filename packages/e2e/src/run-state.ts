import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { E2E } from './env.js';

/** One user that the setup project creates. The password is the current one. */
export interface RunUser {
  id: string;
  email: string;
  password: string;
  displayName: string;
}

/** What the setup project writes for the tests of one run. */
export interface RunState {
  runId: string;
  admin: RunUser;
  viewer: RunUser;
  outsider: RunUser;
}

export type RunRole = 'admin' | 'viewer' | 'outsider';

const authDir = join(E2E.outputDir, 'auth');
const runFile = join(authDir, 'run.json');

/** Playwright storage state files (login session cookies), one for each user. */
export const STATE_FILES: Record<RunRole, string> = {
  admin: join(authDir, 'admin.json'),
  viewer: join(authDir, 'viewer.json'),
  outsider: join(authDir, 'outsider.json'),
};

export function ensureAuthDir(): void {
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
}

export function writeRunState(state: RunState): void {
  ensureAuthDir();
  writeFileSync(runFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

export function readRunState(): RunState {
  return JSON.parse(readFileSync(runFile, 'utf8')) as RunState;
}
