import { describe, expect, it } from 'vitest';
import { liveCookieName, readCookie, serializeLiveCookie } from './cookies.js';

describe('live cookies', () => {
  it('names the cookie with the sid', () => {
    expect(liveCookieName('abcdefgh2345')).toBe('__Host-hydra_live_abcdefgh2345');
  });

  it('serializes the attributes of spec section 9.2', () => {
    expect(serializeLiveCookie('abcdefgh2345', 'v4lue')).toBe(
      '__Host-hydra_live_abcdefgh2345=v4lue; Path=/; HttpOnly; Secure; SameSite=Strict',
    );
  });

  it('reads only the named cookie', () => {
    const header = '__Host-hydra_live_aaaaaaaaaaaa=one; __Host-hydra_live_bbbbbbbbbbbb=two;x=a=b';
    expect(readCookie(header, '__Host-hydra_live_bbbbbbbbbbbb')).toBe('two');
    expect(readCookie(header, '__Host-hydra_live_aaaaaaaaaaaa')).toBe('one');
    expect(readCookie(header, 'x')).toBe('a=b');
    expect(readCookie(header, '__Host-hydra_live_cccccccccccc')).toBeUndefined();
    expect(readCookie(undefined, 'x')).toBeUndefined();
    expect(readCookie('broken; =x', 'broken')).toBeUndefined();
  });
});
