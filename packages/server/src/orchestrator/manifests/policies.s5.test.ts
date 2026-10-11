// Spike S5 (docs/superpowers/spikes/S5-url-policies.md): the Chromium policies of a session.
import type { V1ConfigMap } from '@kubernetes/client-node';
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

function policies(allowlist: string[]): Record<string, unknown> {
  const config = testConfig();
  const input: SessionRow = {
    ...row,
    allowlist,
    appliedSettings: { ...row.appliedSettings, allowlist },
  };
  const objects = buildSessionObjects(input, { config, subkeys: deriveSubkeys(config.secretKey) });
  const configMap = objects.find(
    (o) => o.kind === 'ConfigMap' && o.metadata.name === `chromium-${row.id}`,
  ) as unknown as V1ConfigMap | undefined;
  const text = configMap?.data?.['policies.json'];
  if (!text) throw new Error('no policies.json');
  return JSON.parse(text) as Record<string, unknown>;
}

describe('spike S5 results in policies.ts', () => {
  it('blocks every URL except the session allowlist and about:blank', () => {
    const p = policies(['example.com', '.exact.example.org']);
    expect(p.URLBlocklist).toEqual(['*']);
    expect(p.URLAllowlist).toEqual(['example.com', '.exact.example.org', 'about:blank']);
    expect(p.DeveloperToolsAvailability).toBe(1);
  });

  it('keeps only the Neko default blocklist when the allowlist is ["*"]', () => {
    const p = policies(['*']);
    expect(p).not.toHaveProperty('URLAllowlist');
    expect(p.URLBlocklist).toEqual(['file://*', 'chrome://policy']);
  });

  it('keeps the Neko extension policies and blocks other extensions (spec 7.5)', () => {
    const p = policies(['example.com']);
    expect(p.ExtensionInstallBlocklist).toEqual(['*']);
    expect(p.ExtensionInstallForcelist).toEqual([
      'ddkjiahejlhfcafbddmgiahcphecmpfh;https://clients2.google.com/service/update2/crx',
      'mnjggcdmjocbbbhaepdhchncahnbgone;https://clients2.google.com/service/update2/crx',
    ]);
    expect(p.ExtensionInstallAllowlist).toEqual([
      'ddkjiahejlhfcafbddmgiahcphecmpfh',
      'mnjggcdmjocbbbhaepdhchncahnbgone',
    ]);
  });
});
