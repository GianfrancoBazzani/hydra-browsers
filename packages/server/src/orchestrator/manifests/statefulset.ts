import type { V1ContainerPort, V1SeccompProfile, V1StatefulSet } from '@kubernetes/client-node';
import type { DesiredState, SessionSettings } from '@hydra/shared';
import {
  MCP_PORT,
  NEKO_PORT,
  objectNames,
  SESSION_ID_LABEL,
  sessionLabels,
  STARTED_AT_ANNOTATION,
} from '../names.js';
import type { KubeObject } from '../types.js';
import { buildNekoEnv } from './neko-env.js';

/**
 * Spike S1 switch (index section 6). false is the main path: Chromium keeps --no-sandbox and the pod
 * uses the RuntimeDefault seccomp profile. Plan 09 sets it to true only if spike S1 succeeds; the
 * profile file must then exist on the node (spec sections 11.6 and 11.7).
 */
export const USE_CHROMIUM_SECCOMP_PROFILE = false;

/**
 * Capabilities that the neko container adds after `drop: ALL` (spec section 7.4): supervisord runs as
 * root, switches to the neko user (SETUID, SETGID), changes the owner of its socket (CHOWN), and
 * signals its child processes (KILL). All are in the Pod Security `baseline` list.
 * Spike S1 (docs/superpowers/spikes/S1-sandbox.md): supervisord and Xorg need only these.
 */
export const NEKO_ADDED_CAPABILITIES = ['CHOWN', 'KILL', 'SETGID', 'SETUID'];

export function seccompProfile(): V1SeccompProfile {
  return USE_CHROMIUM_SECCOMP_PROFILE
    ? { type: 'Localhost', localhostProfile: 'hydra/chromium.json' }
    : { type: 'RuntimeDefault' };
}

export interface StatefulSetInput {
  sid: string;
  namespace: string;
  desiredState: DesiredState;
  /** applied_settings of the session (spec section 7.2). */
  settings: SessionSettings;
  mediaPort: number | null;
  startedAt: number | null;
  sessionImage: string;
  mcpImage: string;
  publicIp: string;
}

/** StatefulSet session-<sid> with the pod of spec section 7.4. */
export function buildStatefulSet(input: StatefulSetInput): V1StatefulSet & KubeObject {
  const names = objectNames(input.sid);
  const labels = sessionLabels(input.sid);
  const profileMount = { name: 'profile', mountPath: '/home/neko/.config/chromium' };
  const mediaPorts: V1ContainerPort[] =
    input.mediaPort === null
      ? []
      : [
          { name: 'media-udp', containerPort: input.mediaPort, protocol: 'UDP' },
          { name: 'media-tcp', containerPort: input.mediaPort, protocol: 'TCP' },
        ];
  return {
    apiVersion: 'apps/v1',
    kind: 'StatefulSet',
    metadata: { name: names.statefulSet, namespace: input.namespace, labels },
    spec: {
      replicas: input.desiredState === 'running' ? 1 : 0,
      serviceName: names.headlessService,
      podManagementPolicy: 'Parallel',
      selector: { matchLabels: { [SESSION_ID_LABEL]: input.sid } },
      template: {
        metadata: {
          labels,
          annotations: { [STARTED_AT_ANNOTATION]: String(input.startedAt ?? 0) },
        },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          securityContext: { seccompProfile: seccompProfile() },
          initContainers: [
            {
              name: 'remove-locks',
              image: input.sessionImage,
              command: ['sh', '-c', 'rm -f /home/neko/.config/chromium/Singleton*'],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [profileMount],
            },
          ],
          containers: [
            {
              name: 'neko',
              image: input.sessionImage,
              ports: [{ name: 'http', containerPort: NEKO_PORT, protocol: 'TCP' }, ...mediaPorts],
              env: buildNekoEnv({
                sid: input.sid,
                settings: input.settings,
                mediaPort: input.mediaPort,
                publicIp: input.publicIp,
              }),
              securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'], add: [...NEKO_ADDED_CAPABILITIES] },
              },
              readinessProbe: {
                httpGet: { path: '/health', port: NEKO_PORT },
                periodSeconds: 3,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '500m', memory: '1536Mi' },
                limits: { cpu: '3', memory: '4Gi' },
              },
              volumeMounts: [
                profileMount,
                {
                  name: 'chromium-config',
                  mountPath: '/etc/chromium/policies/managed/policies.json',
                  subPath: 'policies.json',
                  readOnly: true,
                },
                {
                  name: 'chromium-config',
                  mountPath: '/etc/chromium.d/hydra',
                  subPath: 'hydra-flags',
                  readOnly: true,
                },
                { name: 'dshm', mountPath: '/dev/shm' },
              ],
            },
            {
              name: 'mcp',
              image: input.mcpImage,
              command: [
                'hydra-mcp',
                '--cdp-endpoint',
                'http://127.0.0.1:9222',
                '--host',
                '0.0.0.0',
                '--port',
                String(MCP_PORT),
              ],
              ports: [{ name: 'mcp', containerPort: MCP_PORT, protocol: 'TCP' }],
              securityContext: {
                runAsUser: 1000,
                runAsGroup: 1000,
                runAsNonRoot: true,
                allowPrivilegeEscalation: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              readinessProbe: {
                tcpSocket: { port: MCP_PORT },
                periodSeconds: 3,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              resources: {
                requests: { cpu: '100m', memory: '256Mi' },
                limits: { cpu: '500m', memory: '512Mi' },
              },
              volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
            },
          ],
          volumes: [
            { name: 'profile', persistentVolumeClaim: { claimName: names.pvc } },
            { name: 'chromium-config', configMap: { name: names.configMap } },
            { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } },
            { name: 'tmp', emptyDir: {} },
          ],
        },
      },
    },
  };
}
