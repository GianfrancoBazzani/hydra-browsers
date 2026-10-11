import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { AuthedUser, LoginContext } from '../auth/index.js';
import { HydraError } from '../lib/errors.js';
import { requestInfo, requireAdmin, requireLogin } from './context.js';

function user(overrides: Partial<AuthedUser> = {}): AuthedUser {
  return {
    id: 'u1',
    email: 'u1@example.com',
    displayName: 'U1',
    role: 'member',
    status: 'active',
    mustChangePassword: false,
    ...overrides,
  };
}

function request(
  login: LoginContext | null,
  method: string,
  route: string | undefined,
  url = route ?? '/x',
): FastifyRequest {
  return { login, method, url, routeOptions: { url: route } } as unknown as FastifyRequest;
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HydraError ? error.code : 'other';
  }
}

describe('requireLogin', () => {
  it('throws unauthenticated without a login session', () => {
    expect(codeOf(() => requireLogin(request(null, 'GET', '/api/auth/me')))).toBe(
      'unauthenticated',
    );
  });

  it('returns the login context', () => {
    const login = { user: user(), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/users'))).toBe(login);
  });

  it('permits only me, password, and logout while must_change_password is true', () => {
    const login = { user: user({ mustChangePassword: true }), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/auth/me'))).toBe(login);
    expect(requireLogin(request(login, 'POST', '/api/auth/password'))).toBe(login);
    expect(requireLogin(request(login, 'POST', '/api/auth/logout'))).toBe(login);
    for (const [method, route] of [
      ['GET', '/api/users'],
      ['POST', '/api/auth/me'],
      ['HEAD', '/api/auth/me'],
      ['GET', '/api/sessions/:sid/audit'],
    ] as const) {
      expect(codeOf(() => requireLogin(request(login, method, route)))).toBe(
        'password_change_required',
      );
    }
  });

  it('uses the route pattern, not the raw URL', () => {
    const login = { user: user({ mustChangePassword: true }), loginSessionId: 'ls1' };
    expect(requireLogin(request(login, 'GET', '/api/auth/me', '/%61pi/auth/me'))).toBe(login);
    expect(codeOf(() => requireLogin(request(login, 'GET', '/api/users', '/api/auth/me')))).toBe(
      'password_change_required',
    );
  });
});

describe('requireAdmin', () => {
  it('is forbidden for members and returns the context for admins', () => {
    const member = { user: user(), loginSessionId: 'ls1' };
    expect(codeOf(() => requireAdmin(request(member, 'GET', '/api/users')))).toBe('forbidden');
    const admin = { user: user({ role: 'admin' }), loginSessionId: 'ls2' };
    expect(requireAdmin(request(admin, 'GET', '/api/users'))).toBe(admin);
  });
});

describe('requestInfo', () => {
  it('gives the method and the route pattern', () => {
    expect(
      requestInfo(request(null, 'POST', '/api/sessions/:sid/members', '/api/sessions/abc/members')),
    ).toEqual({
      method: 'POST',
      path: '/api/sessions/:sid/members',
    });
  });
});
