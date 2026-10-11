/**
 * Traefik arguments that deploy/traefik/dev.yaml sets through the Helm values of the k3s chart:
 * the responding timeouts of the entry points web and websecure. Keep them equal to that file
 * (scripts/check-repo.ts keeps dev.yaml equal to prod.yaml). Without them, the long MCP stream
 * test would not verify the production timeouts.
 */
export const TRAEFIK_DEV_ARGS: readonly string[] = ['web', 'websecure'].flatMap((entryPoint) => [
  `--entryPoints.${entryPoint}.transport.respondingTimeouts.readTimeout=0s`,
  `--entryPoints.${entryPoint}.transport.respondingTimeouts.writeTimeout=0s`,
  `--entryPoints.${entryPoint}.transport.respondingTimeouts.idleTimeout=180s`,
]);

/** The expected arguments that the Traefik container does not have. Empty means all are there. */
export function missingTraefikArgs(
  args: readonly string[],
  expected: readonly string[] = TRAEFIK_DEV_ARGS,
): string[] {
  const present = new Set(args);
  return expected.filter((arg) => !present.has(arg));
}
