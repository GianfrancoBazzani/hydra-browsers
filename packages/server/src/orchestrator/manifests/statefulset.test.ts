import { describe, expect, it } from 'vitest';
import { buildNekoEnv } from './neko-env.js';
import {
  buildStatefulSet,
  NEKO_ADDED_CAPABILITIES,
  seccompProfile,
  USE_CHROMIUM_SECCOMP_PROFILE,
} from './statefulset.js';

const sid = 'abcdefghij23';
const labels = { 'app.kubernetes.io/managed-by': 'hydra', 'hydra/session-id': sid };
const settings = {
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080' as const,
};
const input = {
  sid,
  namespace: 'hydra-sessions',
  desiredState: 'running' as const,
  settings,
  mediaPort: 52000,
  startedAt: 1791633600000,
  sessionImage: 'registry.example/hydra-session:abc@sha256:1111',
  mcpImage: 'registry.example/hydra-mcp:abc@sha256:2222',
  publicIp: '203.0.113.10',
};

describe('buildStatefulSet', () => {
  it('builds the StatefulSet and the pod of spec sections 7.3 and 7.4', () => {
    expect(buildStatefulSet(input)).toEqual({
      apiVersion: 'apps/v1',
      kind: 'StatefulSet',
      metadata: { name: 'session-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        replicas: 1,
        serviceName: 'session-abcdefghij23',
        podManagementPolicy: 'Parallel',
        selector: { matchLabels: { 'hydra/session-id': sid } },
        template: {
          metadata: { labels, annotations: { 'hydra/started-at': '1791633600000' } },
          spec: {
            automountServiceAccountToken: false,
            enableServiceLinks: false,
            securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
            initContainers: [
              {
                name: 'remove-locks',
                image: 'registry.example/hydra-session:abc@sha256:1111',
                command: ['sh', '-c', 'rm -f /home/neko/.config/chromium/Singleton*'],
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                volumeMounts: [{ name: 'profile', mountPath: '/home/neko/.config/chromium' }],
              },
            ],
            containers: [
              {
                name: 'neko',
                image: 'registry.example/hydra-session:abc@sha256:1111',
                ports: [
                  { name: 'http', containerPort: 8080, protocol: 'TCP' },
                  { name: 'media-udp', containerPort: 52000, protocol: 'UDP' },
                  { name: 'media-tcp', containerPort: 52000, protocol: 'TCP' },
                ],
                env: buildNekoEnv({ sid, settings, mediaPort: 52000, publicIp: '203.0.113.10' }),
                securityContext: {
                  allowPrivilegeEscalation: false,
                  capabilities: {
                    drop: ['ALL'],
                    add: ['CHOWN', 'KILL', 'SETGID', 'SETUID'],
                  },
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: 8080 },
                  periodSeconds: 3,
                  timeoutSeconds: 2,
                  failureThreshold: 3,
                },
                resources: {
                  requests: { cpu: '500m', memory: '1536Mi' },
                  limits: { cpu: '3', memory: '4Gi' },
                },
                volumeMounts: [
                  { name: 'profile', mountPath: '/home/neko/.config/chromium' },
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
                image: 'registry.example/hydra-mcp:abc@sha256:2222',
                command: [
                  'hydra-mcp',
                  '--cdp-endpoint',
                  'http://127.0.0.1:9222',
                  '--host',
                  '0.0.0.0',
                  '--port',
                  '8931',
                ],
                ports: [{ name: 'mcp', containerPort: 8931, protocol: 'TCP' }],
                securityContext: {
                  runAsUser: 1000,
                  runAsGroup: 1000,
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ['ALL'] },
                },
                readinessProbe: {
                  tcpSocket: { port: 8931 },
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
              { name: 'profile', persistentVolumeClaim: { claimName: 'profile-abcdefghij23' } },
              { name: 'chromium-config', configMap: { name: 'chromium-abcdefghij23' } },
              { name: 'dshm', emptyDir: { medium: 'Memory', sizeLimit: '2Gi' } },
              { name: 'tmp', emptyDir: {} },
            ],
          },
        },
      },
    });
  });

  it('has 0 replicas unless desired_state is running', () => {
    expect(buildStatefulSet({ ...input, desiredState: 'stopped' }).spec?.replicas).toBe(0);
    expect(buildStatefulSet({ ...input, desiredState: 'deleted' }).spec?.replicas).toBe(0);
  });

  it('has no media container ports while the session holds no media port', () => {
    const neko = buildStatefulSet({ ...input, desiredState: 'stopped', mediaPort: null }).spec
      ?.template.spec?.containers[0];
    expect(neko?.ports).toEqual([{ name: 'http', containerPort: 8080, protocol: 'TCP' }]);
  });

  it('writes started_at 0 for a session that never started', () => {
    const annotations = buildStatefulSet({ ...input, startedAt: null }).spec?.template.metadata
      ?.annotations;
    expect(annotations).toEqual({ 'hydra/started-at': '0' });
  });

  it('keeps the spike S1 switches on the main path', () => {
    expect(USE_CHROMIUM_SECCOMP_PROFILE).toBe(false);
    expect(seccompProfile()).toEqual({ type: 'RuntimeDefault' });
    expect(NEKO_ADDED_CAPABILITIES).toEqual(['CHOWN', 'KILL', 'SETGID', 'SETUID']);
  });
});
