import type { V1ConfigMap } from '@kubernetes/client-node';
import type { SessionSettings } from '@hydra/shared';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';
import { buildChromiumFlags } from './chromium-flags.js';
import { buildPolicies } from './policies.js';

/** ConfigMap chromium-<sid>: policies.json (spec section 7.5) and hydra-flags (spec section 7.6). */
export function buildConfigMap(
  sid: string,
  namespace: string,
  settings: SessionSettings,
): V1ConfigMap & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'ConfigMap',
    metadata: { name: objectNames(sid).configMap, namespace, labels: sessionLabels(sid) },
    data: {
      'policies.json': `${JSON.stringify(buildPolicies(settings.allowlist), null, 2)}\n`,
      'hydra-flags': buildChromiumFlags(settings.language),
    },
  };
}
