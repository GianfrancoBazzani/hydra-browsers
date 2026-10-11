// Spike S1 (docs/superpowers/spikes/S1-sandbox.md): capabilities and seccomp profile of the pod.
import type { V1Container, V1StatefulSet } from '@kubernetes/client-node';
import { describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/helpers/config.js';
import { deriveSubkeys } from '../../crypto/index.js';
import type { SessionRow } from '../../db/schema.js';
import { buildSessionObjects } from './index.js';

// MINIMAL_CAPS of the S1 result, in alphabetical order.
const S1_CAPABILITIES = ['CHOWN', 'KILL', 'SETGID', 'SETUID'];
// true only for S1 decision row 1. The target-host run is pending (S1 decision row 5): false.
const S1_SANDBOX = false;

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

function statefulSet(): V1StatefulSet {
  const config = testConfig();
  const objects = buildSessionObjects(row, { config, subkeys: deriveSubkeys(config.secretKey) });
  const sts = objects.find((o) => o.kind === 'StatefulSet');
  if (!sts) throw new Error('no StatefulSet');
  return sts as unknown as V1StatefulSet;
}

function nekoContainer(): V1Container {
  const neko = statefulSet().spec?.template.spec?.containers.find((c) => c.name === 'neko');
  if (!neko) throw new Error('no neko container');
  return neko;
}

describe('spike S1 results in statefulset.ts', () => {
  it('drops all capabilities and adds only the set that S1 found', () => {
    expect(nekoContainer().securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(nekoContainer().securityContext?.capabilities).toEqual({
      drop: ['ALL'],
      add: S1_CAPABILITIES,
    });
  });

  it('uses the seccomp profile of the S1 decision', () => {
    expect(statefulSet().spec?.template.spec?.securityContext?.seccompProfile).toEqual(
      S1_SANDBOX
        ? { type: 'Localhost', localhostProfile: 'hydra/chromium.json' }
        : { type: 'RuntimeDefault' },
    );
  });
});
