export const ERROR_CODES = [
  'unauthenticated',
  'csrf_failed',
  'forbidden',
  'not_found',
  'validation_failed',
  'confirm_mismatch',
  'password_rejected',
  'invalid_credentials',
  'password_change_required',
  'rate_limited',
  'conflict',
  'invalid_state',
  'capacity_reached',
  'body_too_large',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * HTTP status of each error code (spec section 12.2). `internal` is an unexpected error: its
 * message gives no details, and the gateway logs the error.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  csrf_failed: 403,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  confirm_mismatch: 400,
  password_rejected: 400,
  invalid_credentials: 401,
  password_change_required: 403,
  rate_limited: 429,
  conflict: 409,
  invalid_state: 409,
  capacity_reached: 409,
  body_too_large: 413,
  internal: 500,
};
