import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Clock } from '../lib/clock.js';

export const BACKUP_DIR = 'backups';
export const BACKUPS_KEPT = 10;
const BACKUP_NAME = /^hydra-\d{8}T\d{9}Z\.db$/;

/** 2026-10-10T12:00:00.123Z → 20261010T120000123Z. Fixed width, so names sort by time. */
function stamp(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/**
 * Copies the database with the SQLite online backup API to `backups/hydra-<timestamp>.db`
 * (mode 0600) and keeps the 10 newest backups (spec section 5.1). Returns the file path.
 * A second backup in the same millisecond replaces the first one.
 */
export async function backupDb(
  sqlite: Database.Database,
  dataDir: string,
  clock: Clock,
): Promise<string> {
  const folder = join(dataDir, BACKUP_DIR);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const file = join(folder, `hydra-${stamp(clock.now())}.db`);
  await sqlite.backup(file);
  chmodSync(file, 0o600);
  pruneBackups(folder);
  return file;
}

/** Deletes all backups except the `keep` newest. Other files in the folder stay. */
export function pruneBackups(folder: string, keep: number = BACKUPS_KEPT): string[] {
  const names = readdirSync(folder)
    .filter((name) => BACKUP_NAME.test(name))
    .sort()
    .reverse();
  const removed = names.slice(keep);
  for (const name of removed) rmSync(join(folder, name), { force: true });
  return removed;
}
