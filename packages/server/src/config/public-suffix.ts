import { isIP } from 'node:net';
import { PUBLIC_SUFFIX_RULES } from './public-suffix-list.js';

interface SuffixRules {
  exact: Set<string>;
  wildcards: Set<string>; // "ck" for the rule "*.ck"
  exceptions: Set<string>; // "www.ck" for the rule "!www.ck"
}

let cached: SuffixRules | undefined;

function rules(): SuffixRules {
  if (cached) return cached;
  const parsed: SuffixRules = { exact: new Set(), wildcards: new Set(), exceptions: new Set() };
  for (const rule of PUBLIC_SUFFIX_RULES.split('\n')) {
    if (rule === '') continue;
    if (rule.startsWith('!')) parsed.exceptions.add(rule.slice(1));
    else if (rule.startsWith('*.')) parsed.wildcards.add(rule.slice(2));
    else parsed.exact.add(rule);
  }
  cached = parsed;
  return parsed;
}

/**
 * The public suffix of a hostname, with the algorithm of https://publicsuffix.org/list/.
 * `hostname` must be in the form of `URL.hostname`: lowercase, ASCII (punycode).
 */
export function publicSuffix(hostname: string): string {
  const { exact, wildcards, exceptions } = rules();
  const labels = hostname.split('.');
  // An exception rule wins over all other rules. Its public suffix drops the leftmost label.
  for (let i = 0; i < labels.length; i++) {
    if (exceptions.has(labels.slice(i).join('.'))) return labels.slice(i + 1).join('.');
  }
  // Otherwise the matching rule with the most labels wins.
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (exact.has(suffix)) return suffix;
    if (i + 1 < labels.length && wildcards.has(labels.slice(i + 1).join('.'))) return suffix;
  }
  // No rule matches: the default rule "*" makes the last label the public suffix.
  return labels[labels.length - 1] ?? hostname;
}

/** The public suffix plus one label, or null if the hostname is a public suffix itself. */
export function registrableDomain(hostname: string): string | null {
  const suffix = publicSuffix(hostname);
  if (suffix === hostname) return null;
  const labels = hostname.split('.');
  return labels.slice(labels.length - suffix.split('.').length - 1).join('.');
}

/** The "site" of an origin (HTML standard): scheme plus registrable domain, or the host itself. */
export function siteOf(url: URL): string {
  const host = url.hostname;
  const bare = host.startsWith('[') ? host.slice(1, -1) : host;
  const domain = isIP(bare) === 0 ? (registrableDomain(host) ?? host) : host;
  return `${url.protocol}//${domain}`;
}
