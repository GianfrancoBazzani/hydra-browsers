import { describe, expect, it } from 'vitest';
import { buildPolicies, DISK_CACHE_SIZE, isAllowAll, NEKO_DEFAULT_POLICIES } from './policies.js';

describe('buildPolicies', () => {
  it('applies the changes of spec section 7.5 to the Neko defaults', () => {
    const policies = buildPolicies(['example.com', '.login.example.org']);
    expect(policies['DeveloperToolsAvailability']).toBe(1);
    expect(policies['URLBlocklist']).toEqual(['*']);
    expect(policies['URLAllowlist']).toEqual(['example.com', '.login.example.org', 'about:blank']);
    expect(policies['PasswordManagerEnabled']).toBe(false);
    expect(policies['DefaultCookiesSetting']).toBe(1);
    expect(policies['RestoreOnStartup']).toBe(1);
    expect(policies['DiskCacheSize']).toBe(536870912);
    expect(policies['DownloadRestrictions']).toBe(3);
    expect(policies['AllowFileSelectionDialogs']).toBe(false);
    expect(policies['ExtensionInstallBlocklist']).toEqual(['*']);
  });

  it('keeps the other Neko defaults, also the two Neko extensions', () => {
    const policies = buildPolicies(['example.com']);
    expect(policies['BrowserSignin']).toBe(0);
    expect(policies['SyncDisabled']).toBe(true);
    expect(policies['IncognitoModeAvailability']).toBe(1);
    // Spec section 7.5: uBlock Origin Lite and SponsorBlock are the only extensions.
    expect(policies['ExtensionInstallForcelist']).toEqual([
      'ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx',
      'mnjggcdmjocbbbhaepdhchncahnbgone;https://clients2.google.com/service/update2/crx',
    ]);
    expect(policies['ExtensionInstallAllowlist']).toEqual([
      'ddkjiahejlhfcafbddmgiahcphecmpfh',
      'mnjggcdmjocbbbhaepdhchncahnbgone',
    ]);
  });

  it('omits URLBlocklist ["*"] and URLAllowlist for the ["*"] allowlist', () => {
    const policies = buildPolicies(['*']);
    expect(policies['URLBlocklist']).toEqual(['file://*', 'chrome://policy']);
    expect('URLAllowlist' in policies).toBe(false);
    expect(policies['DiskCacheSize']).toBe(DISK_CACHE_SIZE);
  });

  it('does not change the default object', () => {
    buildPolicies(['example.com']);
    expect(NEKO_DEFAULT_POLICIES.URLBlocklist).toEqual(['file://*', 'chrome://policy']);
    expect(NEKO_DEFAULT_POLICIES.DeveloperToolsAvailability).toBe(2);
  });

  it('detects the allow-all list', () => {
    expect(isAllowAll(['*'])).toBe(true);
    expect(isAllowAll(['*', 'example.com'])).toBe(false);
    expect(isAllowAll(['example.com'])).toBe(false);
  });
});
