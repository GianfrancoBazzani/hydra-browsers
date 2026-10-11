/**
 * Chromium policies (spec section 7.5). Spike S5 fallback file (index section 6).
 *
 * NEKO_DEFAULT_POLICIES is a copy of `apps/chromium/policies.json` of Neko v3.1.6
 * (github.com/m1k1o/neko, tag v3.1.6, commit 65fba485de2987998c7028b04240b21669d674e0).
 */
export const NEKO_DEFAULT_POLICIES = {
  AutofillAddressEnabled: false,
  AutofillCreditCardEnabled: false,
  BrowserSignin: 0,
  DefaultNotificationsSetting: 2,
  DeveloperToolsAvailability: 2,
  EditBookmarksEnabled: false,
  FullscreenAllowed: true,
  IncognitoModeAvailability: 1,
  SyncDisabled: true,
  AutoplayAllowed: true,
  BrowserAddPersonEnabled: false,
  BrowserGuestModeEnabled: false,
  DefaultPopupsSetting: 2,
  DownloadRestrictions: 3,
  VideoCaptureAllowed: true,
  AllowFileSelectionDialogs: false,
  PromptForDownloadLocation: false,
  BookmarkBarEnabled: false,
  PasswordManagerEnabled: false,
  BrowserLabsEnabled: false,
  CommandLineFlagSecurityWarningsEnabled: false,
  URLAllowlist: ['file:///home/neko/Downloads'],
  URLBlocklist: ['file://*', 'chrome://policy'],
  // Spec section 7.5 keeps these two Neko defaults: uBlock Origin Lite (ddkj…) and SponsorBlock
  // (mnjg…) are the only extensions. ExtensionInstallBlocklist ["*"] blocks all other extensions.
  ExtensionInstallForcelist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx',
    'mnjggcdmjocbbbhaepdhchncahnbgone;https://clients2.google.com/service/update2/crx',
  ],
  ExtensionInstallAllowlist: [
    'ddkjiahejlhfcafbddmgiahcphecmpfh',
    'mnjggcdmjocbbbhaepdhchncahnbgone',
  ],
  ExtensionInstallBlocklist: ['*'],
} as const;

/** 512 MiB (spec section 7.5). */
export const DISK_CACHE_SIZE = 536870912;

export function isAllowAll(allowlist: readonly string[]): boolean {
  return allowlist.length === 1 && allowlist[0] === '*';
}

/** The full policies.json object for one session. */
export function buildPolicies(allowlist: readonly string[]): Record<string, unknown> {
  const policies: Record<string, unknown> = structuredClone(NEKO_DEFAULT_POLICIES);
  policies['DeveloperToolsAvailability'] = 1;
  policies['PasswordManagerEnabled'] = false;
  policies['DefaultCookiesSetting'] = 1;
  policies['RestoreOnStartup'] = 1;
  policies['DiskCacheSize'] = DISK_CACHE_SIZE;
  policies['DownloadRestrictions'] = 3;
  policies['AllowFileSelectionDialogs'] = false;
  policies['ExtensionInstallBlocklist'] = ['*'];
  if (isAllowAll(allowlist)) {
    // Keep only the Neko default blocklist, and no URLAllowlist.
    policies['URLBlocklist'] = [...NEKO_DEFAULT_POLICIES.URLBlocklist];
    delete policies['URLAllowlist'];
  } else {
    policies['URLBlocklist'] = ['*'];
    policies['URLAllowlist'] = [...allowlist, 'about:blank'];
  }
  return policies;
}
