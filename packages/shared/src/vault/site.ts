// The site rule of a fill (spec section 6.9.2). The gateway calculates the match with the public suffix
// list; this file only applies it, so the sidecar and the gateway use one implementation.

export interface VaultSiteMatch {
  scheme: 'https:' | 'http:';
  matchDomain: string;
  matchSubdomains: boolean;
}

/** The sites of a match in words, for the agent and the dashboard. */
export function describeSiteMatch(
  match: Pick<VaultSiteMatch, 'matchDomain' | 'matchSubdomains'>,
): string {
  return match.matchSubdomains ? `${match.matchDomain} and its subdomains` : match.matchDomain;
}

/** True if `url` has the scheme of the website, and its host is matchDomain or (if permitted) a subdomain. */
export function vaultSiteMatches(url: string, match: VaultSiteMatch): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== match.scheme) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === match.matchDomain) return true;
  return match.matchSubdomains && host.endsWith(`.${match.matchDomain}`);
}

/**
 * The origin of a website input (spec section 6.9.1). Adds https:// if the input has no scheme. Null if
 * the result is not an http or https URL with a host, or if it has a user name or a password.
 */
export function normalizeWebsite(input: string): URL | null {
  const text = input.trim();
  if (text === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.hostname === '') return null;
  return new URL(url.origin);
}
