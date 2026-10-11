import { describe, expect, it } from 'vitest';
import { deriveSubkeys, nekoPassword } from '../../crypto/index.js';
import { testConfig } from '../../../test/helpers/config.js';
import { buildConfigMap } from './configmap.js';
import { buildHeadlessService } from './headless-service.js';
import { buildMediaService } from './media-service.js';
import { buildPolicies } from './policies.js';
import { buildPvc } from './pvc.js';
import { buildSecret } from './secret.js';

const sid = 'abcdefghij23';
const labels = { 'app.kubernetes.io/managed-by': 'hydra', 'hydra/session-id': sid };

describe('session object builders', () => {
  it('builds the profile PVC', () => {
    expect(buildPvc(sid, 'hydra-sessions')).toEqual({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name: 'profile-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        storageClassName: 'hydra-profile',
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: '5Gi' } },
      },
    });
  });

  it('builds the Neko password Secret from the neko subkey', () => {
    const subkeys = deriveSubkeys(testConfig().secretKey);
    const secret = buildSecret(sid, 'hydra-sessions', subkeys.neko);
    const decode = (value: string | undefined) =>
      Buffer.from(value ?? '', 'base64').toString('utf8');
    expect(secret.metadata).toEqual({
      name: 'neko-abcdefghij23',
      namespace: 'hydra-sessions',
      labels,
    });
    expect(secret.type).toBe('Opaque');
    expect(Object.keys(secret.data ?? {}).sort()).toEqual(['admin-password', 'user-password']);
    expect(decode(secret.data?.['admin-password'])).toBe(nekoPassword(subkeys.neko, sid, 'admin'));
    expect(decode(secret.data?.['user-password'])).toBe(nekoPassword(subkeys.neko, sid, 'user'));
    expect(secret.data?.['admin-password']).not.toBe(secret.data?.['user-password']);
  });

  it('builds the Chromium ConfigMap', () => {
    const settings = {
      allowlist: ['example.com'],
      timezone: 'UTC',
      language: 'en-US',
      screen: '1920x1080' as const,
    };
    const configMap = buildConfigMap(sid, 'hydra-sessions', settings);
    expect(configMap.metadata).toEqual({
      name: 'chromium-abcdefghij23',
      namespace: 'hydra-sessions',
      labels,
    });
    expect(JSON.parse(configMap.data?.['policies.json'] ?? '')).toEqual(
      buildPolicies(['example.com']),
    );
    expect(configMap.data?.['hydra-flags']).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=en-US --accept-lang=en-US,en"\n',
    );
  });

  it('builds the headless Service', () => {
    expect(buildHeadlessService(sid, 'hydra-sessions')).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'session-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        clusterIP: 'None',
        selector: { 'hydra/session-id': sid },
        ports: [
          { name: 'neko', protocol: 'TCP', port: 8080, targetPort: 8080 },
          { name: 'mcp', protocol: 'TCP', port: 8931, targetPort: 8931 },
        ],
      },
    });
  });

  it('builds the media Service with port = targetPort = nodePort for UDP and TCP', () => {
    expect(buildMediaService(sid, 'hydra-sessions', 52007)).toEqual({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'media-abcdefghij23', namespace: 'hydra-sessions', labels },
      spec: {
        type: 'NodePort',
        externalTrafficPolicy: 'Local',
        selector: { 'hydra/session-id': sid },
        ports: [
          { name: 'media-udp', protocol: 'UDP', port: 52007, targetPort: 52007, nodePort: 52007 },
          { name: 'media-tcp', protocol: 'TCP', port: 52007, targetPort: 52007, nodePort: 52007 },
        ],
      },
    });
  });
});
