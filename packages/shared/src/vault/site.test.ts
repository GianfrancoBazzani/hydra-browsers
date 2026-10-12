import { describe, expect, it } from 'vitest';
import { normalizeWebsite, vaultSiteMatches, type VaultSiteMatch } from './site.js';

const GOOGLE: VaultSiteMatch = {
  scheme: 'https:',
  matchDomain: 'google.com',
  matchSubdomains: true,
};

describe('vaultSiteMatches', () => {
  it('matches the domain and its subdomains on the same scheme', () => {
    expect(vaultSiteMatches('https://google.com/', GOOGLE)).toBe(true);
    expect(vaultSiteMatches('https://accounts.google.com:8443/signin', GOOGLE)).toBe(true);
    expect(vaultSiteMatches('http://accounts.google.com/', GOOGLE)).toBe(false);
    expect(vaultSiteMatches('https://google.com.evil.example/', GOOGLE)).toBe(false);
    expect(vaultSiteMatches('https://notgoogle.com/', GOOGLE)).toBe(false);
  });

  it('matches only the exact host when matchSubdomains is false', () => {
    const ip: VaultSiteMatch = {
      scheme: 'https:',
      matchDomain: '10.0.0.1',
      matchSubdomains: false,
    };
    expect(vaultSiteMatches('https://10.0.0.1/', ip)).toBe(true);
    const github: VaultSiteMatch = {
      scheme: 'https:',
      matchDomain: 'github.io',
      matchSubdomains: false,
    };
    expect(vaultSiteMatches('https://alice.github.io/', github)).toBe(false);
  });

  it('does not match about:, data:, blob:, or text that is not a URL', () => {
    for (const url of [
      'about:blank',
      'about:srcdoc',
      'data:text/html,x',
      'blob:https://google.com/1',
      '',
      'x',
    ]) {
      expect(vaultSiteMatches(url, GOOGLE)).toBe(false);
    }
  });
});

describe('normalizeWebsite', () => {
  it('adds https:// and keeps only the origin', () => {
    expect(normalizeWebsite('www.google.com/accounts?x=1')?.origin).toBe('https://www.google.com');
    expect(normalizeWebsite(' https://Example.COM:8443/a ')?.origin).toBe(
      'https://example.com:8443',
    );
    expect(normalizeWebsite('http://testsite.local/')?.origin).toBe('http://testsite.local');
  });

  it('rejects other schemes and URLs with a user name or a password', () => {
    expect(normalizeWebsite('ftp://example.com')).toBeNull();
    expect(normalizeWebsite('https://user:pass@example.com')).toBeNull();
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('')).toBeNull();
  });
});
