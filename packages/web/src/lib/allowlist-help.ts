/**
 * Help text of the allowlist editor (spec sections 7.2 and 8.7), from spike S5
 * (docs/superpowers/spikes/S5-url-policies.md): the allowlist stops navigations and redirects to
 * other hosts, but not the requests that pages make.
 */
export const ALLOWLIST_HELP =
  'Hosts that the browser may open. example.com permits the host and its subdomains, ' +
  '.example.com only that host. Use * to permit all domains. Redirects and frames to other ' +
  'hosts are blocked too. Pages on these hosts can still load images and scripts from other ' +
  'hosts and send data to any host, so the allowlist does not prevent data exfiltration.';
