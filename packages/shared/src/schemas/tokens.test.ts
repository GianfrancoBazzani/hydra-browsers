import { describe, expect, it } from 'vitest';
import { CreateTokenRequestSchema } from './tokens.js';

describe('CreateTokenRequestSchema', () => {
  it.each([1, 7, 30, 90, 365])('accepts an expiry of %i days', (days) => {
    expect(CreateTokenRequestSchema.parse({ name: 'ci', expiresInDays: days }).expiresInDays).toBe(
      days,
    );
  });

  it('uses 30 days when the expiry is missing', () => {
    expect(CreateTokenRequestSchema.parse({ name: 'ci' })).toEqual({
      name: 'ci',
      expiresInDays: 30,
    });
  });

  it.each([0, 2, 366, '30', null])('rejects the expiry %j', (days) => {
    expect(CreateTokenRequestSchema.safeParse({ name: 'ci', expiresInDays: days }).success).toBe(
      false,
    );
  });

  it.each(['claude-laptop', 'cursor_1', 'A'])('accepts the name %j', (name) => {
    expect(CreateTokenRequestSchema.safeParse({ name }).success).toBe(true);
  });

  it.each(['', 'my token', 'x'.repeat(65), 'a;rm', 'ü'])('rejects the name %j', (name) => {
    expect(CreateTokenRequestSchema.safeParse({ name }).success).toBe(false);
  });
});
