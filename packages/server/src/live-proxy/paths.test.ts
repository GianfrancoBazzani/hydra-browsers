import { describe, expect, it } from 'vitest';
import { parseLivePath, upstreamPathOf } from './paths.js';

const SID = 'abcdefgh2345';

describe('parseLivePath', () => {
  it('splits the sid, the path without the prefix, and the raw query', () => {
    expect(parseLivePath(`/s/${SID}/`)).toEqual({ sessionId: SID, path: '/', search: '' });
    expect(parseLivePath(`/s/${SID}/ws?password=x&username=a%20b`)).toEqual({
      sessionId: SID,
      path: '/ws',
      search: 'password=x&username=a%20b',
    });
    expect(parseLivePath(`/s/${SID}//other.example/x`)).toEqual({
      sessionId: SID,
      path: '//other.example/x',
      search: '',
    });
  });

  it('returns null for other URLs', () => {
    expect(parseLivePath(`/s/${SID}`)).toBeNull();
    expect(parseLivePath('/s/ABCDEFGH2345/')).toBeNull();
    expect(parseLivePath('/s/abc/')).toBeNull();
    expect(parseLivePath(`/x/${SID}/`)).toBeNull();
    expect(parseLivePath(`http://evil.example/s/${SID}/`)).toBeNull();
  });
});

describe('upstreamPathOf', () => {
  it('keeps the raw query when nothing is set', () => {
    expect(upstreamPathOf({ sessionId: SID, path: '/a', search: 'x=%20&y' }, {})).toBe(
      '/a?x=%20&y',
    );
    expect(upstreamPathOf({ sessionId: SID, path: '/a', search: '' }, {})).toBe('/a');
  });

  it('replaces values and keeps the other parameters', () => {
    const path = upstreamPathOf(
      { sessionId: SID, path: '/ws', search: 'password=x&username=evil&other=1' },
      { username: 'Ada Lovelace', password: 'p-w_d' },
    );
    const query = new URLSearchParams(path.slice(path.indexOf('?') + 1));
    expect(path.startsWith('/ws?')).toBe(true);
    expect(query.getAll('username')).toEqual(['Ada Lovelace']);
    expect(query.getAll('password')).toEqual(['p-w_d']);
    expect(query.get('other')).toBe('1');
  });
});
