import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/helpers/clock.js';
import { createTestDb, type TestDb } from '../../test/helpers/db.js';
import { backupDb } from './backup.js';
import { openDb, type OpenedDb } from './open.js';

const INSERT_EVENT =
  "INSERT INTO audit_events (ts, kind, actor_type, data) VALUES (1, 'auth.login', 'system', '{}')";

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('backupDb', () => {
  let testDb: TestDb | undefined;
  afterEach(() => {
    testDb?.close();
  });

  it('writes a consistent copy named after the clock time, with mode 0600', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 2, 3, 4, 5, 6));
    testDb = createTestDb(clock);
    testDb.sqlite.prepare(INSERT_EVENT).run();
    const file = await backupDb(testDb.sqlite, testDb.dataDir, clock);
    expect(file).toBe(join(testDb.dataDir, 'backups', 'hydra-20260102T030405006Z.db'));
    expect(mode(join(testDb.dataDir, 'backups'))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    const copy = new Database(file, { readonly: true });
    expect(copy.prepare('SELECT count(*) FROM audit_events').pluck().get()).toBe(1);
    copy.close();
  });

  it('keeps the 10 newest backups and deletes no other files', async () => {
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    testDb = createTestDb(clock);
    const folder = join(testDb.dataDir, 'backups');
    for (let i = 0; i < 12; i++) {
      await testDb.backup();
      if (i === 0) writeFileSync(join(folder, 'notes.txt'), 'keep me');
      clock.advance(60_000);
    }
    const names = readdirSync(folder).sort();
    expect(names).toHaveLength(11);
    expect(names).toContain('notes.txt');
    expect(names).not.toContain('hydra-20260101T000000000Z.db');
    expect(names).not.toContain('hydra-20260101T000100000Z.db');
    expect(names).toContain('hydra-20260101T000200000Z.db');
    expect(names).toContain('hydra-20260101T001100000Z.db');
  });
});

describe('openDb', () => {
  const logger = pino({ level: 'silent' });
  const clock = new FakeClock(Date.UTC(2026, 9, 10, 12, 0, 0, 123));
  let root: string;
  let dataDir: string;
  let opened: OpenedDb | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'hydra-open-db-'));
    dataDir = join(root, 'data');
  });

  afterEach(() => {
    if (opened?.sqlite.open) opened.close();
    opened = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('migrates a new database and makes no backup of it', async () => {
    opened = await openDb({ dataDir, logger, clock });
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(opened.sqlite.prepare('SELECT count(*) FROM users').pluck().get()).toBe(0);
    expect(existsSync(join(dataDir, 'backups'))).toBe(false);
  });

  it('makes a backup before the migrations when the database has data', async () => {
    (await openDb({ dataDir, logger, clock })).close();
    const first = new Database(join(dataDir, 'hydra.db'));
    first.prepare(INSERT_EVENT).run();
    first.close();

    opened = await openDb({ dataDir, logger, clock });
    expect(readdirSync(join(dataDir, 'backups'))).toEqual(['hydra-20261010T120000123Z.db']);
    const backup = new Database(join(dataDir, 'backups', 'hydra-20261010T120000123Z.db'), {
      readonly: true,
    });
    expect(backup.prepare('SELECT count(*) FROM audit_events').pluck().get()).toBe(1);
    backup.close();
  });

  it('rejects when a migration fails, after the backup', async () => {
    mkdirSync(dataDir, { mode: 0o700 });
    const broken = new Database(join(dataDir, 'hydra.db'));
    broken.prepare('CREATE TABLE users (id TEXT)').run(); // the first migration creates users
    broken.close();

    await expect(openDb({ dataDir, logger, clock })).rejects.toThrow(/users/);
    expect(readdirSync(join(dataDir, 'backups'))).toHaveLength(1);
    const check = new Database(join(dataDir, 'hydra.db'));
    const tables = check
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all();
    check.close();
    expect(tables).not.toContain('sessions'); // the migration transaction rolled back
  });
});
