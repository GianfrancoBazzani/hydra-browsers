import { describe, expect, it } from 'vitest';
import { deriveSubkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { testConfig } from '../../../test/helpers/config.js';
import { buildSessionObjects } from './index.js';

const config = testConfig();
const subkeys = deriveSubkeys(config.secretKey);
const row: SessionRow = {
  id: 'abcdefghij23',
  name: 'Research',
  ownerId: 'user-1',
  desiredState: 'running',
  state: 'starting',
  errorReason: null,
  mediaPort: 52000,
  allowlist: ['changed.example.com'],
  timezone: 'Asia/Tokyo',
  language: 'ja-JP',
  screen: '1280x720',
  appliedSettings: {
    allowlist: ['example.com'],
    timezone: 'UTC',
    language: 'en-US',
    screen: '1920x1080',
  },
  startedAt: 1791633600000,
  readyAt: null,
  createdAt: 1791633000000,
  updatedAt: 1791633600000,
  deletedAt: null,
};

describe('buildSessionObjects', () => {
  it('builds the objects of spec section 7.3 in apply order', () => {
    const objects = buildSessionObjects(row, { config, subkeys });
    expect(objects.map((o) => `${o.kind}/${o.metadata.name}`)).toEqual([
      'PersistentVolumeClaim/profile-abcdefghij23',
      'Secret/neko-abcdefghij23',
      'ConfigMap/chromium-abcdefghij23',
      'Service/session-abcdefghij23',
      'Service/media-abcdefghij23',
      'StatefulSet/session-abcdefghij23',
    ]);
    for (const object of objects) {
      expect(object.metadata.namespace).toBe('hydra-sessions');
      expect(object.metadata.labels).toEqual({
        'app.kubernetes.io/managed-by': 'hydra',
        'hydra/session-id': 'abcdefghij23',
      });
    }
  });

  it('uses applied_settings, not the current settings', () => {
    const objects = buildSessionObjects(row, { config, subkeys });
    const configMap = objects.find((o) => o.kind === 'ConfigMap') as unknown as {
      data: Record<string, string>;
    };
    const policies = JSON.parse(configMap.data['policies.json'] ?? '') as Record<string, unknown>;
    expect(policies['URLAllowlist']).toEqual(['example.com', 'about:blank']);
    expect(configMap.data['hydra-flags']).toContain('--lang=en-US');
    expect(JSON.stringify(objects)).not.toContain('Asia/Tokyo');
  });

  it('has no media Service while media_port is null', () => {
    const objects = buildSessionObjects(
      { ...row, desiredState: 'stopped', mediaPort: null },
      { config, subkeys },
    );
    expect(objects.some((o) => o.metadata.name === 'media-abcdefghij23')).toBe(false);
  });

  it('matches the snapshot', () => {
    expect(buildSessionObjects(row, { config, subkeys })).toMatchSnapshot();
  });
});
