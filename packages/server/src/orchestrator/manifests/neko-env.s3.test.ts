// Spike S3 (docs/superpowers/spikes/S3-viewer-profile.md): the Neko user profile cannot host.
import type { V1Container, V1StatefulSet } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/helpers/config.js';
import { deriveSubkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { buildSessionObjects } from './index.js';

const row: SessionRow = {
  id: 'abcdefghijkl',
  name: 'Spike results',
  ownerId: '01JA0000000000000000000000',
  desiredState: 'running',
  state: 'starting',
  errorReason: null,
  mediaPort: 52000,
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080',
  appliedSettings: {
    allowlist: ['example.com'],
    timezone: 'UTC',
    language: 'en-US',
    screen: '1920x1080',
  },
  startedAt: 1_760_000_000_000,
  readyAt: null,
  createdAt: 1_760_000_000_000,
  updatedAt: 1_760_000_000_000,
  deletedAt: null,
};

function nekoContainer(): V1Container {
  const config = testConfig();
  const objects = buildSessionObjects(row, { config, subkeys: deriveSubkeys(config.secretKey) });
  const sts = objects.find((o) => o.kind === 'StatefulSet') as unknown as V1StatefulSet | undefined;
  const neko = sts?.spec?.template.spec?.containers.find((c) => c.name === 'neko');
  if (!neko) throw new Error('no neko container');
  return neko;
}

describe('spike S3 result in neko-env.ts', () => {
  it('keeps the multiuser provider', () => {
    const env = nekoContainer().env ?? [];
    expect(env.find((e) => e.name === 'NEKO_MEMBER_PROVIDER')?.value).toBe('multiuser');
  });

  it('gives the Neko user profile can_host: false', () => {
    const env = nekoContainer().env ?? [];
    const profile = env.find((e) => e.name === 'NEKO_MEMBER_MULTIUSER_USER_PROFILE');
    expect(profile?.value).toBeDefined();
    expect(JSON.parse(profile?.value ?? 'null')).toEqual({ can_host: false });
  });
});
