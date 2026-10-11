import { describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  parseCookies,
  serializeCookie,
  sessionCookie,
} from './cookies.js';

describe('parseCookies', () => {
  it('returns an empty object for a missing header', () => {
    expect(Object.keys(parseCookies(undefined))).toEqual([]);
    expect(Object.keys(parseCookies(''))).toEqual([]);
  });

  it('parses several cookies and trims spaces', () => {
    const cookies = parseCookies(`a=1;  ${SESSION_COOKIE}=abc_-123 ; b="quoted"`);
    expect(cookies.a).toBe('1');
    expect(cookies[SESSION_COOKIE]).toBe('abc_-123');
    expect(cookies.b).toBe('quoted');
  });

  it('keeps the first value of a repeated name', () => {
    expect(parseCookies('a=first; a=second').a).toBe('first');
  });

  it('ignores parts without a name or without "="', () => {
    expect(parseCookies('=x; junk; c=3')).toEqual(Object.assign(Object.create(null), { c: '3' }));
  });

  it('is safe against prototype keys', () => {
    const cookies = parseCookies('__proto__=x; constructor=y');
    expect(cookies.__proto__).toBe('x');
    expect(cookies.constructor).toBe('y');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not decode values', () => {
    expect(parseCookies('a=%E0%A4%A').a).toBe('%E0%A4%A');
  });
});

describe('serializeCookie', () => {
  it('builds the login session cookie of spec section 6.4', () => {
    expect(sessionCookie('abc')).toBe(
      '__Host-hydra_session=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('clears the login session cookie with Max-Age=0', () => {
    expect(clearedSessionCookie()).toBe(
      '__Host-hydra_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('supports Strict, Max-Age, and turning off the default flags', () => {
    expect(
      serializeCookie('x', 'y', {
        sameSite: 'Strict',
        maxAge: 30.9,
        httpOnly: false,
        secure: false,
      }),
    ).toBe('x=y; Path=/; Max-Age=30; SameSite=Strict');
  });

  it('rejects names and values that RFC 6265 does not permit', () => {
    expect(() => serializeCookie('a b', 'y', { sameSite: 'Lax' })).toThrow(/name/);
    expect(() => serializeCookie('a', 'x;y', { sameSite: 'Lax' })).toThrow(/value/);
    expect(() => serializeCookie('a', 'x y', { sameSite: 'Lax' })).toThrow(/value/);
  });
});
