import { describe, expect, it } from 'vitest';
import { ipInCidr, normalizeIp } from './net.js';

describe('normalizeIp', () => {
  it('removes the IPv4-mapped IPv6 prefix', () => {
    expect(normalizeIp('::ffff:172.18.0.3')).toBe('172.18.0.3');
    expect(normalizeIp('::FFFF:10.42.0.7')).toBe('10.42.0.7');
  });

  it('keeps other addresses', () => {
    expect(normalizeIp('172.18.0.3')).toBe('172.18.0.3');
    expect(normalizeIp('::1')).toBe('::1');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8::1');
  });
});

describe('ipInCidr', () => {
  it('finds addresses inside the k3s pod CIDR', () => {
    expect(ipInCidr('10.42.0.1', '10.42.0.0/16')).toBe(true);
    expect(ipInCidr('10.42.255.254', '10.42.0.0/16')).toBe(true);
  });

  it('rejects addresses outside the CIDR', () => {
    expect(ipInCidr('10.43.0.1', '10.42.0.0/16')).toBe(false);
    expect(ipInCidr('172.18.0.3', '10.42.0.0/16')).toBe(false);
  });

  it('returns false for IPv6 addresses and for values that are not addresses', () => {
    expect(ipInCidr('::1', '10.42.0.0/16')).toBe(false);
    expect(ipInCidr('not-an-ip', '10.42.0.0/16')).toBe(false);
    expect(ipInCidr('10.42.0.1', 'bad-cidr')).toBe(false);
  });
});
