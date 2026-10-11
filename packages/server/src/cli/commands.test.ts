import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PasswordHasher, deriveSubkeys } from '../crypto/index.js';
import { openDb } from '../db/index.js';
import { users } from '../db/schema.js';
import { systemClock } from '../lib/clock.js';
import { createLogger } from '../lib/logger.js';
import { runCli, type CliIo } from './commands.js';
import { PromptCancelledError } from './prompt.js';

const SECRET_KEY = Buffer.alloc(32, 7).toString('base64');
const PEPPER = deriveSubkeys(Buffer.from(SECRET_KEY, 'base64')).passwordPepper;

function env(dataDir: string): Record<string, string> {
  return {
    HYDRA_DATA_DIR: dataDir,
    HYDRA_SECRET_KEY: SECRET_KEY,
    HYDRA_PUBLIC_URL: 'http://hydra.localhost',
    HYDRA_LIVE_URL: 'http://live.hydra.localhost',
    HYDRA_PUBLIC_IP: '127.0.0.1',
    HYDRA_SESSION_IMAGE: `localhost:5000/hydra-session:test@sha256:${'a'.repeat(64)}`,
    HYDRA_MCP_IMAGE: `localhost:5000/hydra-mcp:test@sha256:${'b'.repeat(64)}`,
  };
}

/**
 * `secrets` are the answers of the terminal (`interactive`) or the lines of stdin. When they run
 * out, readSecret rejects as the real reader does at the end of stdin.
 */
function io(
  environment: Record<string, string | undefined>,
  secrets: string[] = [],
  interactive = true,
) {
  const out: string[] = [];
  const err: string[] = [];
  let reads = 0;
  const cli: CliIo = {
    env: environment,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    interactive,
    readSecret: () => {
      reads += 1;
      const next = secrets.shift();
      return next === undefined
        ? Promise.reject(new PromptCancelledError('No password on stdin.'))
        : Promise.resolve(next);
    },
  };
  return { cli, out: () => out.join(''), err: () => err.join(''), reads: () => reads };
}

describe('hydra CLI', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'hydra-cli-'));
  });

  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  async function userRow(email: string) {
    const db = await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock });
    try {
      return db.db.select().from(users).where(eq(users.email, email)).get();
    } finally {
      db.close();
    }
  }

  it('keygen prints a new 32-byte key in base64', async () => {
    const run = io({});
    expect(await runCli(['keygen'], run.cli)).toBe(0);
    expect(Buffer.from(run.out().trim(), 'base64')).toHaveLength(32);
  });

  it('prints the usage for an unknown command, a missing --email, or an unknown option', async () => {
    for (const argv of [
      [],
      ['nope'],
      ['user', 'create'],
      ['user', 'create', '--email', 'a@b.co', '--root'],
    ]) {
      const run = io(env(dataDir));
      expect(await runCli(argv, run.cli), argv.join(' ')).toBe(2);
      expect(run.err()).toContain('Usage:');
    }
  });

  it('user create --admin asks the password two times and creates an admin', async () => {
    const run = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(
      await runCli(['user', 'create', '--admin', '--email', 'Root@Example.com'], run.cli),
    ).toBe(0);
    expect(run.out()).toMatch(/^Created admin root@example\.com \(.+\)\.\n$/);
    const row = await userRow('root@example.com');
    expect(row).toMatchObject({
      role: 'admin',
      displayName: 'Root',
      mustChangePassword: false,
      status: 'active',
    });
    const hasher = new PasswordHasher(PEPPER);
    expect(await hasher.verify(row?.passwordHash ?? '', 'a long admin passphrase')).toBe(true);
  });

  it('without a terminal reads the password from the first line of stdin, one time (spec 6.3)', async () => {
    const create = io(env(dataDir), ['a long admin passphrase', 'a second line'], false);
    expect(
      await runCli(['user', 'create', '--admin', '--email', 'first@example.com'], create.cli),
    ).toBe(0);
    expect(create.reads()).toBe(1);
    expect(create.out()).toMatch(/^Created admin first@example\.com \(.+\)\.\n$/);
    const reset = io(env(dataDir), ['the new passphrase!'], false);
    expect(
      await runCli(['user', 'reset-password', '--email', 'first@example.com'], reset.cli),
    ).toBe(0);
    const row = await userRow('first@example.com');
    expect(row).toMatchObject({ role: 'admin', mustChangePassword: false });
    const hasher = new PasswordHasher(PEPPER);
    expect(await hasher.verify(row?.passwordHash ?? '', 'the new passphrase!')).toBe(true);
    const empty = io(env(dataDir), [], false);
    expect(await runCli(['user', 'create', '--email', 'empty@example.com'], empty.cli)).toBe(1);
    expect(empty.err()).toBe('hydra: No password on stdin.\n');
  });

  it('user create on a terminal fails for different passwords, a weak password, and an existing email', async () => {
    const differ = io(env(dataDir), ['a long admin passphrase', 'another passphrase!!']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], differ.cli)).toBe(1);
    expect(differ.err()).toBe('hydra: The passwords are not the same.\n');
    const weak = io(env(dataDir), ['Password1234', 'Password1234']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], weak.cli)).toBe(1);
    expect(weak.err()).toContain('too common');
    const first = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(
      await runCli(['user', 'create', '--email', 'a@example.com', '--name', 'Ann'], first.cli),
    ).toBe(0);
    expect((await userRow('a@example.com'))?.role).toBe('member');
    const again = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], again.cli)).toBe(1);
    expect(again.err()).toContain('exists');
  });

  it('rejects an invalid --email with exit 2 before any prompt and before the database opens', async () => {
    for (const args of [
      ['user', 'create', '--email', 'not-an-email'],
      ['user', 'reset-password', '--email', 'not-an-email'],
    ]) {
      const bad = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
      expect(await runCli(args, bad.cli)).toBe(2);
      expect(bad.err()).toContain('hydra: Enter an email address.\n');
      expect(bad.reads()).toBe(0);
      expect(readdirSync(dataDir)).toEqual([]);
    }
  });

  it('prints the fields of a validation_failed error after the message', async () => {
    const long = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    const code = await runCli(
      ['user', 'create', '--email', 'a@example.com', '--name', 'x'.repeat(65)],
      long.cli,
    );
    expect(code).toBe(1);
    expect(long.err()).toBe(
      'hydra: The request is not valid.\nhydra: displayName: Use 1 to 64 characters.\n',
    );
  });

  it('user reset-password sets a typed password and ends the lock', async () => {
    const create = io(env(dataDir), ['a long admin passphrase', 'a long admin passphrase']);
    await runCli(['user', 'create', '--email', 'ops@example.com'], create.cli);
    const db = await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock });
    db.db
      .update(users)
      .set({ lockedAt: Date.now(), failedLogins: 100 })
      .where(eq(users.email, 'ops@example.com'))
      .run();
    db.close();
    const run = io(env(dataDir), ['the new passphrase!', 'the new passphrase!']);
    expect(await runCli(['user', 'reset-password', '--email', 'ops@example.com'], run.cli)).toBe(0);
    expect(await userRow('ops@example.com')).toMatchObject({
      lockedAt: null,
      failedLogins: 0,
      mustChangePassword: false,
    });
    const missing = io(env(dataDir), ['the new passphrase!', 'the new passphrase!']);
    expect(
      await runCli(['user', 'reset-password', '--email', 'ghost@example.com'], missing.cli),
    ).toBe(1);
  });

  it('db backup writes a backup file and prints its path', async () => {
    const none = io(env(dataDir));
    expect(await runCli(['db', 'backup'], none.cli)).toBe(1);
    expect(none.err()).toContain('No database');
    (await openDb({ dataDir, logger: createLogger('fatal'), clock: systemClock })).close();
    const before = existsSync(join(dataDir, 'backups'))
      ? readdirSync(join(dataDir, 'backups')).length
      : 0;
    const run = io(env(dataDir));
    expect(await runCli(['db', 'backup'], run.cli)).toBe(0);
    const path = run.out().trim();
    expect(existsSync(path)).toBe(true);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(before + 1);
  });

  it('names the variable when the configuration is not valid', async () => {
    const run = io({ ...env(dataDir), HYDRA_SECRET_KEY: undefined }, [
      'a long admin passphrase',
      'a long admin passphrase',
    ]);
    expect(await runCli(['user', 'create', '--email', 'a@example.com'], run.cli)).toBe(1);
    expect(run.err()).toContain('HYDRA_SECRET_KEY');
  });
});
