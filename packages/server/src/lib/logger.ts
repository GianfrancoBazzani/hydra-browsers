import { pino, type LoggerOptions } from 'pino';
import type { Config } from '../config/index.js';

export type Logger = import('pino').Logger;

const SECRET_FIELDS = ['password', 'token', 'ticket'];

/** Spec section 14: the headers with credentials, and all fields named password, token, ticket. */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  ...SECRET_FIELDS.flatMap((field) => [field, `*.${field}`, `*.*.${field}`, `*.*.*.${field}`]),
];

export function loggerOptions(level: Config['logLevel']): LoggerOptions {
  return { level, redact: { paths: [...REDACT_PATHS], censor: '[redacted]' } };
}

/** pino JSON logs to stdout. */
export function createLogger(level: Config['logLevel']): Logger {
  return pino(loggerOptions(level));
}
