import { tmpdir } from 'node:os';
import { join } from 'node:path';

const env = process.env;

const testsiteHost = env.HYDRA_E2E_TESTSITE_HOST ?? 'testsite.hydra-testsite.svc.cluster.local';
/** Port of the Service `testsite` (the container listens on 8080). */
const testsitePort = Number(env.HYDRA_E2E_TESTSITE_PORT ?? '80');

/**
 * The values that plans 01 to 09 fix: the dev overlay, scripts/dev-cluster.sh, and the test site.
 * This file is the only place that names them. Environment variables override the defaults.
 */
export const E2E = {
  /** HYDRA_PUBLIC_URL of the dev overlay. */
  publicUrl: env.HYDRA_E2E_PUBLIC_URL ?? 'http://hydra.localhost',
  /** HYDRA_LIVE_URL of the dev overlay. */
  liveUrl: env.HYDRA_E2E_LIVE_URL ?? 'http://live.hydra.localhost',
  /** kubectl context of the k3d cluster "hydra-dev" (k3d names it "k3d-<cluster>"). */
  kubeContext: env.HYDRA_E2E_KUBE_CONTEXT ?? 'k3d-hydra-dev',
  /** Docker network of the k3d cluster (k3d names it "k3d-<cluster>"). */
  dockerNetwork: env.HYDRA_E2E_DOCKER_NETWORK ?? 'k3d-hydra-dev',
  gatewayNamespace: 'hydra',
  gatewayDeployment: 'hydra-gateway',
  gatewayService: 'hydra-gateway',
  gatewayDataPvc: 'gateway-data',
  sessionNamespace: 'hydra-sessions',
  prepullDaemonSet: 'session-image-prepull',
  testsite: {
    namespace: env.HYDRA_E2E_TESTSITE_NAMESPACE ?? 'hydra-testsite',
    deployment: 'testsite',
    /** Host name that Chromium in a session pod uses. It is the allowlist entry of the e2e sessions. */
    host: testsiteHost,
    port: testsitePort,
    /** The URL parser drops a default port, as Chromium does in the page URL. */
    origin: new URL(`http://${testsiteHost}:${testsitePort}`).origin,
    /** Route that sets the cookie to its parameter `value` (persistent, in document.cookie). */
    cookiePath: '/set-cookie',
    cookieParam: 'value',
    cookieName: 'hydra_testsite',
    /** Route that redirects to the absolute URL in the query parameter. */
    redirectPath: '/redirect',
    redirectParam: 'to',
  },
  /** A domain that no e2e allowlist contains. */
  blockedUrl: 'https://example.com/',
  /** k3s default pod and service CIDRs. HYDRA_TRUSTED_PROXIES defaults to the pod CIDR (spec section 4). */
  podCidr: '10.42.0.0/16',
  serviceCidr: '10.43.0.0/16',
  /** Optional: the exact client address that the gateway must record (spec section 15.3). */
  expectedClientIp: env.HYDRA_E2E_CLIENT_IP,
  /** All files of a run (logins, results, report) go here, outside the repository. */
  outputDir: env.HYDRA_E2E_OUTPUT_DIR ?? join(tmpdir(), 'hydra-e2e'),
} as const;

export function testsiteUrl(path: string): string {
  return `${E2E.testsite.origin}${path}`;
}

/** URL that sets the test cookie to `value` (1 to 64 characters of A-Z a-z 0-9 _ -). */
export function setCookieUrl(value: string): string {
  const query = new URLSearchParams({ [E2E.testsite.cookieParam]: value });
  return `${E2E.testsite.origin}${E2E.testsite.cookiePath}?${query.toString()}`;
}

export function redirectUrl(target: string): string {
  const query = new URLSearchParams({ [E2E.testsite.redirectParam]: target });
  return `${E2E.testsite.origin}${E2E.testsite.redirectPath}?${query.toString()}`;
}
