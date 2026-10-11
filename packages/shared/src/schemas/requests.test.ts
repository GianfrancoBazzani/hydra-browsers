import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from './api-error.js';
import { AuditQuerySchema } from './audit.js';
import { LoginRequestSchema } from './auth.js';
import { AddMemberRequestSchema } from './members.js';
import { CreateUserRequestSchema, UpdateUserRequestSchema } from './users.js';

describe('user and member requests', () => {
  it('normalizes emails to trimmed lowercase', () => {
    expect(
      CreateUserRequestSchema.parse({
        email: ' Alice@Example.COM ',
        displayName: ' Alice ',
        role: 'member',
      }),
    ).toEqual({ email: 'alice@example.com', displayName: 'Alice', role: 'member' });
    expect(AddMemberRequestSchema.parse({ email: 'Bob@Example.com', role: 'viewer' })).toEqual({
      email: 'bob@example.com',
      role: 'viewer',
    });
  });

  it.each(['not-an-email', 'a@b', '', `${'a'.repeat(250)}@example.com`])(
    'rejects the email %j',
    (email) => {
      expect(
        CreateUserRequestSchema.safeParse({ email, displayName: 'A', role: 'member' }).success,
      ).toBe(false);
    },
  );

  it('rejects owner as a member role', () => {
    expect(
      AddMemberRequestSchema.safeParse({ email: 'a@example.com', role: 'owner' }).success,
    ).toBe(false);
  });

  it('accepts an empty user update', () => {
    expect(UpdateUserRequestSchema.parse({})).toEqual({});
  });

  it('lowercases the login email but keeps any text', () => {
    expect(LoginRequestSchema.parse({ email: ' Admin ', password: 'x' })).toEqual({
      email: 'admin',
      password: 'x',
    });
  });
});

describe('AuditQuerySchema', () => {
  it('coerces numbers from the query string', () => {
    expect(AuditQuerySchema.parse({ before: '120', limit: '50', status: 'ok' })).toEqual({
      before: 120,
      limit: 50,
      status: 'ok',
    });
  });

  it.each([{ limit: '0' }, { limit: '201' }, { limit: 'abc' }, { before: '-1' }, { kind: 'x' }])(
    'rejects %j',
    (query) => {
      expect(AuditQuerySchema.safeParse(query).success).toBe(false);
    },
  );
});

describe('ApiErrorSchema', () => {
  it('accepts the error format of spec section 12.2', () => {
    const body = {
      error: { code: 'validation_failed', message: 'Invalid', fields: { name: 'Too long' } },
    };
    expect(ApiErrorSchema.parse(body)).toEqual(body);
    expect(ApiErrorSchema.safeParse({ error: { code: 'teapot', message: 'x' } }).success).toBe(
      false,
    );
  });
});
