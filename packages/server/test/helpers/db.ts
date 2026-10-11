import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupDb } from '../../src/db/backup.js';
import { createDb, migrateDb, openSqlite, type Db, type Sqlite } from '../../src/db/open.js';
import type { Clock } from '../../src/lib/clock.js';
import { FakeClock } from './clock.js';

export interface TestDb {
  db: Db;
  sqlite: Sqlite;
  dataDir: string;
  /** The clock of createTestDb(). */
  clock: Clock;
  /** backupDb() for this database, with the clock of createTestDb(). */
  backup(): Promise<string>;
  /** Closes the database and deletes the temporary folder. */
  close(): void;
}

/** A migrated database in a new temporary folder, with the pragmas of production. */
export function createTestDb(clock: Clock = new FakeClock()): TestDb {
  const dataDir = mkdtempSync(join(tmpdir(), 'hydra-db-'));
  const sqlite = openSqlite(dataDir);
  const db = createDb(sqlite);
  migrateDb(db);
  return {
    db,
    sqlite,
    dataDir,
    clock,
    backup: () => backupDb(sqlite, dataDir, clock),
    close: () => {
      if (sqlite.open) sqlite.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
