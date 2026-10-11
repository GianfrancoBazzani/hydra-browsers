import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Clock } from '../lib/clock.js';
import type { Logger } from '../lib/logger.js';
import { backupDb } from './backup.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;
export type Sqlite = Database.Database;

export interface OpenedDb {
  db: Db;
  sqlite: Sqlite;
  close(): void;
}

export const DB_FILE = 'hydra.db';

/**
 * packages/server/drizzle: the nearest `drizzle/meta/_journal.json` above this module. It works
 * from src/db (development and tests) and from the build output (production).
 */
export function migrationsFolder(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let level = 0; level < 5; level++) {
    const candidate = join(dir, 'drizzle');
    if (existsSync(join(candidate, 'meta', '_journal.json'))) return candidate;
    dir = dirname(dir);
  }
  throw new Error('Cannot find the migrations folder packages/server/drizzle');
}

function setMode(path: string, mode: number, logger: Logger | undefined): void {
  try {
    chmodSync(path, mode);
  } catch (error) {
    // For example a volume folder that another user owns. The data stays usable.
    logger?.warn({ path, mode: mode.toString(8), err: error }, 'cannot set the file mode');
  }
}

/**
 * Creates HYDRA_DATA_DIR (0700) and hydra.db (0600), opens SQLite, and sets the pragmas of spec
 * section 6.2. The file exists with mode 0600 before SQLite opens it, and SQLite gives the -wal
 * and -shm files the mode of the database file.
 */
export function openSqlite(dataDir: string, logger?: Logger): Sqlite {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  setMode(dataDir, 0o700, logger);
  const file = join(dataDir, DB_FILE);
  closeSync(openSync(file, 'a', 0o600));
  setMode(file, 0o600, logger);
  const sqlite = new Database(file);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('busy_timeout = 5000');
  return sqlite;
}

export function createDb(sqlite: Sqlite): Db {
  return drizzle({ client: sqlite, schema });
}

/** Applies the pending migrations in one transaction (the Drizzle migrator rolls back on error). */
export function migrateDb(db: Db): void {
  migrate(db, { migrationsFolder: migrationsFolder() });
}

function hasTables(sqlite: Sqlite): boolean {
  const count = sqlite
    .prepare("SELECT count(*) FROM sqlite_master WHERE type = 'table'")
    .pluck()
    .get() as number;
  return count > 0;
}

/**
 * Opens the gateway database: folder, file, pragmas, a backup (if the database is not new), and
 * the migrations (spec sections 5.1 and 11.8). If a migration fails, the promise rejects; the
 * gateway must then stop.
 */
export async function openDb(options: {
  dataDir: string;
  logger: Logger;
  clock: Clock;
}): Promise<OpenedDb> {
  const sqlite = openSqlite(options.dataDir, options.logger);
  try {
    const db = createDb(sqlite);
    if (hasTables(sqlite)) {
      const file = await backupDb(sqlite, options.dataDir, options.clock);
      options.logger.info({ file }, 'database backup before migrations');
    }
    migrateDb(db);
    return { db, sqlite, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
