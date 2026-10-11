import { ERROR_STATUS, type ErrorCode } from '@hydra/shared';

/** A service error. Only `api/errors.ts` turns it into an HTTP response (index section 2.4). */
export class HydraError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly fields: Record<string, string> | undefined;

  constructor(code: ErrorCode, message: string, fields?: Record<string, string>) {
    super(message);
    this.name = 'HydraError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.fields = fields;
  }
}
