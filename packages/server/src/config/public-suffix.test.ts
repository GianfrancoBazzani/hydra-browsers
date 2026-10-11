import { describe, expect, it } from 'vitest';
import { publicSuffix, registrableDomain, siteOf } from './public-suffix.js';

// Vectors from tests/test_psl.txt of the Public Suffix List (public domain).
const VECTORS: [string, string | null][] = [
  ['com', null],
  ['example.com', 'example.com'],
  ['a.b.example.com', 'example.com'],
  ['uk.com', null],
  ['b.example.uk.com', 'example.uk.com'],
  ['example', null],
  ['b.example.example', 'example.example'],
  ['mm', null],
  ['c.mm', null],
  ['a.b.c.mm', 'b.c.mm'],
  ['jp', null],
  ['www.test.jp', 'test.jp'],
  ['ac.jp', null],
  ['www.test.ac.jp', 'test.ac.jp'],
  ['ide.kyoto.jp', null],
  ['a.b.ide.kyoto.jp', 'b.ide.kyoto.jp'],
  ['c.kobe.jp', null],
  ['a.b.c.kobe.jp', 'b.c.kobe.jp'],
  ['city.kobe.jp', 'city.kobe.jp'],
  ['www.city.kobe.jp', 'city.kobe.jp'],
  ['ck', null],
  ['test.ck', null],
  ['a.b.test.ck', 'b.test.ck'],
  ['www.ck', 'www.ck'],
  ['www.www.ck', 'www.ck'],
  ['k12.ak.us', null],
  ['www.test.k12.ak.us', 'test.k12.ak.us'],
  ['xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
  ['www.xn--85x722f.xn--55qx5d.cn', 'xn--85x722f.xn--55qx5d.cn'],
  ['xn--55qx5d.cn', null],
  ['www.xn--85x722f.xn--fiqs8s', 'xn--85x722f.xn--fiqs8s'],
];

describe('registrableDomain', () => {
  it.each(VECTORS)('%s → %s', (hostname, expected) => {
    expect(registrableDomain(hostname)).toBe(expected);
  });

  it('uses the PRIVATE section of the list', () => {
    expect(publicSuffix('team.github.io')).toBe('github.io');
    expect(registrableDomain('team.github.io')).toBe('team.github.io');
  });

  it('treats localhost like an unlisted top-level domain', () => {
    expect(registrableDomain('localhost')).toBeNull();
    expect(registrableDomain('hydra.localhost')).toBe('hydra.localhost');
    expect(registrableDomain('live.hydra.localhost')).toBe('hydra.localhost');
    expect(registrableDomain('live.localhost')).toBe('live.localhost');
  });
});

describe('siteOf', () => {
  it.each([
    ['https://hydra.example.com', 'https://example.com'],
    ['https://live.hydra.example.com:8443', 'https://example.com'],
    ['http://live.hydra.localhost', 'http://hydra.localhost'],
    ['http://localhost:8080', 'http://localhost'],
    ['https://10.0.0.1', 'https://10.0.0.1'],
    ['https://[::1]:8080', 'https://[::1]'],
  ])('%s → %s', (url, site) => {
    expect(siteOf(new URL(url))).toBe(site);
  });
});
