// The site match of a credential (spec section 6.9.2), calculated at each use from the website.
import type { VaultSiteMatch } from '@hydra/shared';
import { siteDomainOf } from '../config/index.js';

export function siteMatchOf(website: string): VaultSiteMatch {
  const url = new URL(website);
  const domain = siteDomainOf(url.hostname);
  return {
    scheme: url.protocol === 'http:' ? 'http:' : 'https:',
    matchDomain: domain ?? url.hostname,
    matchSubdomains: domain !== null,
  };
}

/** https, or http for a hostname in HYDRA_VAULT_HTTP_HOSTS (spec sections 6.9.1 and 6.9.2). */
export function websitePermitted(website: string, httpHosts: readonly string[]): boolean {
  const url = new URL(website);
  return (
    url.protocol === 'https:' || (url.protocol === 'http:' && httpHosts.includes(url.hostname))
  );
}
