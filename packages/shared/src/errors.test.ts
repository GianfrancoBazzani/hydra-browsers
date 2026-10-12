import { describe, expect, it } from 'vitest';
import { ERROR_CODES, ERROR_STATUS } from './errors.js';

describe('ERROR_STATUS', () => {
  it('maps each error code to the HTTP status of spec section 12.2', () => {
    expect(ERROR_STATUS).toEqual({
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
      vault_limit_reached: 409,
      body_too_large: 413,
      internal: 500,
    });
  });

  it('has one entry for each code and no other entries', () => {
    expect(Object.keys(ERROR_STATUS).sort()).toEqual([...ERROR_CODES].sort());
  });
});
