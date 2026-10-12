import { describe, expect, it } from 'vitest';
import { siteMatchOf, websitePermitted } from './site.js';

describe('siteMatchOf', () => {
  it('uses the registrable domain', () => {
    expect(siteMatchOf('https://www.google.com')).toEqual({
      scheme: 'https:',
      matchDomain: 'google.com',
      matchSubdomains: true,
    });
    expect(siteMatchOf('https://login.example.co.uk')).toEqual({
      scheme: 'https:',
      matchDomain: 'example.co.uk',
      matchSubdomains: true,
    });
    expect(siteMatchOf('https://alice.github.io')).toEqual({
      scheme: 'https:',
      matchDomain: 'alice.github.io',
      matchSubdomains: true,
    });
    expect(siteMatchOf('http://testsite.hydra-testsite.svc.cluster.local')).toEqual({
      scheme: 'http:',
      matchDomain: 'cluster.local',
      matchSubdomains: true,
    });
  });

  it('uses the exact host for an IP address, a public suffix, or one label', () => {
    expect(siteMatchOf('https://10.0.0.1:8443')).toEqual({
      scheme: 'https:',
      matchDomain: '10.0.0.1',
      matchSubdomains: false,
    });
    expect(siteMatchOf('https://[::1]')).toEqual({
      scheme: 'https:',
      matchDomain: '[::1]',
      matchSubdomains: false,
    });
    expect(siteMatchOf('https://github.io')).toEqual({
      scheme: 'https:',
      matchDomain: 'github.io',
      matchSubdomains: false,
    });
    expect(siteMatchOf('https://intranet')).toEqual({
      scheme: 'https:',
      matchDomain: 'intranet',
      matchSubdomains: false,
    });
  });
});

describe('websitePermitted', () => {
  it('permits https, and http only for the listed hosts', () => {
    expect(websitePermitted('https://example.com', [])).toBe(true);
    expect(websitePermitted('http://example.com', [])).toBe(false);
    expect(websitePermitted('http://testsite.local', ['testsite.local'])).toBe(true);
    expect(websitePermitted('http://other.local', ['testsite.local'])).toBe(false);
  });
});
