import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AccessService } from '../access/index.js';
import { AuditWriter } from '../audit/index.js';
import { AuthService, normalizeEmail } from '../auth/index.js';
import { ConfigError, loadConfig } from '../config/index.js';
import { PasswordHasher, deriveSubkeys, generateRootKey } from '../crypto/index.js';
import { DB_FILE, backupDb, openDb, openSqlite } from '../db/index.js';
import { EventBus } from '../events/index.js';
import { systemClock } from '../lib/clock.js';
import { HydraError } from '../lib/errors.js';
import { createLogger } from '../lib/logger.js';
import { TokensService } from '../tokens/index.js';
import { UsersService, isValidEmail } from '../users/index.js';
import { PromptCancelledError } from './prompt.js';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** True if stdin is a terminal: the CLI asks two times and does not show the typed text. */
  interactive: boolean;
  /** On a terminal: shows the prompt and reads the answer. Else: the next line of stdin. */
  readSecret(prompt: string): Promise<string>;
}

export const USAGE = `Usage:
  hydra keygen
  hydra user create --email <email> [--admin] [--name <display name>]
  hydra user reset-password --email <email>
  hydra db backup
`;

class UsageError extends Error {}

/** Runs one CLI command. Returns the exit code: 0 done, 1 failed, 2 usage error. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (group === 'keygen' && command === undefined) {
      io.stdout(`${generateRootKey()}\n`);
      return 0;
    }
    if (group === 'user' && command === 'create') return await userCreate(rest, io);
    if (group === 'user' && command === 'reset-password') return await userResetPassword(rest, io);
    if (group === 'db' && command === 'backup') return await dbBackup(rest, io);
    throw new UsageError(
      argv.length === 0 ? 'No command given.' : `Unknown command: ${argv.join(' ')}`,
    );
  } catch (error) {
    if (error instanceof UsageError || isParseArgsError(error)) {
      io.stderr(`hydra: ${(error as Error).message}\n${USAGE}`);
      return 2;
    }
    if (
      error instanceof HydraError ||
      error instanceof ConfigError ||
      error instanceof PromptCancelledError
    ) {
      io.stderr(`hydra: ${error.message}\n`);
      if (error instanceof HydraError && error.code === 'validation_failed') {
        for (const [field, message] of Object.entries(error.fields ?? {})) {
          io.stderr(`hydra: ${field}: ${message}\n`);
        }
      }
      return 1;
    }
    throw error;
  }
}

function isParseArgsError(error: unknown): boolean {
  return (
    error instanceof TypeError && 'code' in error && String(error.code).startsWith('ERR_PARSE_ARGS')
  );
}

/** `--email` is checked with the rule of UsersService, before any prompt and database access. */
function requireEmail(value: string | undefined): string {
  if (value === undefined) throw new UsageError('--email is necessary.');
  if (!isValidEmail(normalizeEmail(value))) throw new UsageError('Enter an email address.');
  // The service normalizes again; the display name default keeps the typed case.
  return value;
}

/**
 * Spec section 6.3. On a terminal: asks two times without echo, and the answers must be equal.
 * Without a terminal: the password is the first line of stdin, and the CLI does not ask again.
 */
async function askNewPassword(io: CliIo): Promise<string> {
  if (!io.interactive) return io.readSecret('Password: ');
  const password = await io.readSecret('Password: ');
  const repeated = await io.readSecret('Repeat the password: ');
  if (password !== repeated) {
    throw new HydraError('password_rejected', 'The passwords are not the same.');
  }
  return password;
}

/** Opens the database (backup and migrations, as at gateway start) and builds the user services. */
async function withUsers<T>(
  env: CliIo['env'],
  run: (users: UsersService) => Promise<T>,
): Promise<T> {
  const config = loadConfig(env);
  const logger = createLogger('error');
  const clock = systemClock;
  const database = await openDb({ dataDir: config.dataDir, logger, clock });
  try {
    const db = database.db;
    const bus = new EventBus(logger);
    const subkeys = deriveSubkeys(config.secretKey);
    const audit = new AuditWriter({ db, bus, clock });
    const hasher = new PasswordHasher(subkeys.passwordPepper);
    const access = new AccessService({ db, clock, audit, bus });
    const tokens = new TokensService({ db, clock, subkeys, access, audit, bus });
    const auth = new AuthService({ db, clock, subkeys, hasher, audit, bus });
    return await run(new UsersService({ db, clock, hasher, auth, tokens, audit, bus }));
  } finally {
    database.close();
  }
}

async function userCreate(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      email: { type: 'string' },
      admin: { type: 'boolean', default: false },
      name: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  const email = requireEmail(values.email);
  const password = await askNewPassword(io);
  const user = await withUsers(io.env, (users) =>
    users.createWithPassword({
      email,
      displayName: values.name ?? email.split('@')[0] ?? email,
      role: values.admin ? 'admin' : 'member',
      password,
    }),
  );
  io.stdout(`Created ${user.role} ${user.email} (${user.id}).\n`);
  return 0;
}

async function userResetPassword(args: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args,
    options: { email: { type: 'string' } },
    strict: true,
    allowPositionals: false,
  });
  const email = requireEmail(values.email);
  const password = await askNewPassword(io);
  const user = await withUsers(io.env, (users) => users.setPassword(email, password));
  io.stdout(`New password set for ${user.email}. Its login sessions ended and its lock ended.\n`);
  return 0;
}

/**
 * Backup without migrations (`openSqlite`, not `openDb`), so a backup never changes the schema next
 * to the running gateway. Safe while the gateway runs (SQLite online backup API, WAL mode).
 */
async function dbBackup(args: string[], io: CliIo): Promise<number> {
  parseArgs({ args, options: {}, strict: true, allowPositionals: false });
  const config = loadConfig(io.env);
  const file = join(config.dataDir, DB_FILE);
  // openSqlite creates a missing file, so check first.
  if (!existsSync(file)) throw new HydraError('not_found', `No database at ${file}.`);
  const sqlite = openSqlite(config.dataDir);
  try {
    io.stdout(`${await backupDb(sqlite, config.dataDir, systemClock)}\n`);
    return 0;
  } finally {
    sqlite.close();
  }
}
