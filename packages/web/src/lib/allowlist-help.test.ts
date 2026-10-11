import { describe, expect, it } from 'vitest';
import { ALLOWLIST_HELP } from './allowlist-help';

describe('ALLOWLIST_HELP (spike S5)', () => {
  it('describes the host forms of spec 7.2', () => {
    expect(ALLOWLIST_HELP).toContain('example.com permits the host and its subdomains');
    expect(ALLOWLIST_HELP).toContain('.example.com only that host');
    expect(ALLOWLIST_HELP).toContain('Use * to permit all domains');
  });

  it('describes the navigation guard that S5 observed', () => {
    expect(ALLOWLIST_HELP).toContain('Redirects and frames to other hosts are blocked too');
  });

  it('says that the allowlist does not prevent data exfiltration', () => {
    expect(ALLOWLIST_HELP).toContain('does not prevent data exfiltration');
  });
});
