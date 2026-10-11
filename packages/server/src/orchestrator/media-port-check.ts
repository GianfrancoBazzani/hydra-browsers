import type { Config } from '../config/index.js';
import type { Logger } from '../lib/logger.js';
import type { KubeClient } from './types.js';

export class MediaPortRangeError extends Error {
  readonly variable = 'HYDRA_MEDIA_PORT_RANGE';
}

/**
 * Startup check of spec section 4: the media port range must be inside the node port range of the
 * cluster. The gateway stops if the API server answers that a port is not in the valid range. Other
 * answers pass. If the API server does not answer, the check logs a warning and passes.
 */
export async function checkMediaPortRange(deps: {
  kube: KubeClient;
  config: Config;
  logger: Logger;
}): Promise<void> {
  const { first, last } = deps.config.mediaPortRange;
  const ports = first === last ? [first] : [first, last];
  let result: { outOfRange: boolean; message: string | null };
  try {
    result = await deps.kube.checkNodePorts(ports);
  } catch (error) {
    deps.logger.warn(
      { err: error },
      'HYDRA_MEDIA_PORT_RANGE check skipped: the Kubernetes API did not answer',
    );
    return;
  }
  if (result.outOfRange) {
    throw new MediaPortRangeError(
      `HYDRA_MEDIA_PORT_RANGE ${first}-${last} is not inside the service-node-port-range of the cluster: ${result.message ?? 'port not in the valid range'}`,
    );
  }
}
