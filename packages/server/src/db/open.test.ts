import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb, migrateDb, migrationsFolder, openSqlite, type Sqlite } from './open.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('migrationsFolder', () => {
  it('finds packages/server/drizzle', () => {
    expect(migrationsFolder()).toBe(fileURLToPath(new URL('../../drizzle', import.meta.url)));
  });
});

describe('openSqlite and migrateDb', () => {
  let root: string;
  let dataDir: string;
  let sqlite: Sqlite | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hydra-open-'));
    dataDir = join(root, 'data');
  });

  afterEach(() => {
    if (sqlite?.open) sqlite.close();
    sqlite = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('creates the folder with mode 0700 and the database files with mode 0600', () => {
    sqlite = openSqlite(dataDir);
    sqlite.prepare('CREATE TABLE probe (x)').run();
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'hydra.db'))).toBe(0o600);
    expect(mode(join(dataDir, 'hydra.db-wal'))).toBe(0o600);
    expect(mode(join(dataDir, 'hydra.db-shm'))).toBe(0o600);
  });

  it('corrects the mode of an existing folder and file', () => {
    mkdirSync(dataDir, { mode: 0o755 });
    chmodSync(dataDir, 0o755);
    openSqlite(dataDir).close();
    chmodSync(join(dataDir, 'hydra.db'), 0o644);
    sqlite = openSqlite(dataDir);
    expect(mode(dataDir)).toBe(0o700);
    expect(mode(join(dataDir, 'hydra.db'))).toBe(0o600);
  });

  it('sets the pragmas of spec section 6.2', () => {
    sqlite = openSqlite(dataDir);
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);
  });

  it('migrates all tables, and a second run applies nothing again', () => {
    sqlite = openSqlite(dataDir);
    migrateDb(createDb(sqlite));
    migrateDb(createDb(sqlite));
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .pluck()
      .all();
    expect(tables).toEqual(
      expect.arrayContaining([
        'agent_tokens',
        'audit_events',
        'live_grants',
        'login_sessions',
        'session_members',
        'sessions',
        'users',
      ]),
    );
    expect(sqlite.prepare('SELECT count(*) FROM __drizzle_migrations').pluck().get()).toBe(1);
  });
});
