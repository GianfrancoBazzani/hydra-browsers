import { describe, expect, it } from 'vitest';
import { HydraError } from './errors.js';

describe('HydraError', () => {
  it('takes the HTTP status from the error code', () => {
    const error = new HydraError('validation_failed', 'Invalid input', { name: 'Too long' });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('HydraError');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('validation_failed');
    expect(error.status).toBe(400);
    expect(error.fields).toEqual({ name: 'Too long' });
    expect(new HydraError('capacity_reached', 'Full').status).toBe(409);
    expect(new HydraError('not_found', 'Not found').fields).toBeUndefined();
  });
});
