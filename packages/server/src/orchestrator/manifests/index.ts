import type { Config } from '../../config/index.js';
import type { Subkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { desiredStateOf } from '../row-fields.js';
import type { KubeObject } from '../types.js';
import { buildConfigMap } from './configmap.js';
import { buildHeadlessService } from './headless-service.js';
import { buildMediaService } from './media-service.js';
import { buildPvc } from './pvc.js';
import { buildSecret } from './secret.js';
import { buildStatefulSet } from './statefulset.js';

/**
 * The objects of spec section 7.3 for one session, in apply order. Built only from applied_settings,
 * media_port, started_at, and desired_state (spec sections 7.2 and 7.9). The media Service is in the
 * list only while the session holds a media port.
 */
export function buildSessionObjects(
  row: SessionRow,
  context: { config: Config; subkeys: Subkeys },
): KubeObject[] {
  const sid = row.id;
  const namespace = context.config.sessionNamespace;
  const settings = row.appliedSettings;
  const objects: KubeObject[] = [
    buildPvc(sid, namespace),
    buildSecret(sid, namespace, context.subkeys.neko),
    buildConfigMap(sid, namespace, settings),
    buildHeadlessService(sid, namespace),
  ];
  if (row.mediaPort !== null) objects.push(buildMediaService(sid, namespace, row.mediaPort));
  objects.push(
    buildStatefulSet({
      sid,
      namespace,
      desiredState: desiredStateOf(row),
      settings,
      mediaPort: row.mediaPort,
      startedAt: row.startedAt,
      sessionImage: context.config.sessionImage,
      mcpImage: context.config.mcpImage,
      publicIp: context.config.publicIp,
    }),
  );
  return objects;
}

export { buildConfigMap } from './configmap.js';
export { buildChromiumFlags } from './chromium-flags.js';
export { buildHeadlessService } from './headless-service.js';
export { buildMediaService } from './media-service.js';
export { buildNekoEnv, VIEWER_PROFILE_ENV } from './neko-env.js';
export { buildPolicies, DISK_CACHE_SIZE, isAllowAll, NEKO_DEFAULT_POLICIES } from './policies.js';
export { buildPvc } from './pvc.js';
export { buildSecret } from './secret.js';
export {
  buildStatefulSet,
  NEKO_ADDED_CAPABILITIES,
  seccompProfile,
  USE_CHROMIUM_SECCOMP_PROFILE,
} from './statefulset.js';
