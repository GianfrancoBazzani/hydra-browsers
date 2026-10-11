import type { V1Secret } from '@kubernetes/client-node';
import { nekoPassword } from '../../crypto/index.js';
import { objectNames, sessionLabels } from '../names.js';
import type { KubeObject } from '../types.js';

const base64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

/** Secret neko-<sid> with the Neko passwords of spec section 6.7. */
export function buildSecret(
  sid: string,
  namespace: string,
  nekoKey: Buffer,
): V1Secret & KubeObject {
  return {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: { name: objectNames(sid).secret, namespace, labels: sessionLabels(sid) },
    type: 'Opaque',
    data: {
      'admin-password': base64(nekoPassword(nekoKey, sid, 'admin')),
      'user-password': base64(nekoPassword(nekoKey, sid, 'user')),
    },
  };
}
