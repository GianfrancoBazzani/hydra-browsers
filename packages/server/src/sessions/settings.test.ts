import { describe, expect, it } from 'vitest';
import type { SessionRow } from '../db/schema.js';
import { currentSettings, restartRequired, sameSettings } from './settings.js';

const applied = {
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080' as const,
};
const row = (fields: Partial<SessionRow>): SessionRow => ({
  id: 'abcdefghij23',
  name: 'Research',
  ownerId: 'user-1',
  desiredState: 'running',
  state: 'running',
  errorReason: null,
  mediaPort: 52000,
  allowlist: ['example.com'],
  timezone: 'UTC',
  language: 'en-US',
  screen: '1920x1080',
  appliedSettings: applied,
  startedAt: 1,
  readyAt: 2,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
  ...fields,
});

describe('session settings', () => {
  it('reads the current settings of the row', () => {
    expect(currentSettings(row({ timezone: 'Asia/Tokyo' }))).toEqual({
      ...applied,
      timezone: 'Asia/Tokyo',
    });
  });

  it('compares settings, with the allowlist in order', () => {
    expect(sameSettings(applied, { ...applied })).toBe(true);
    expect(sameSettings(applied, { ...applied, screen: '1280x720' })).toBe(false);
    expect(
      sameSettings(
        { ...applied, allowlist: ['a.com', 'b.com'] },
        { ...applied, allowlist: ['b.com', 'a.com'] },
      ),
    ).toBe(false);
  });

  it('needs a restart only while the session has a pod and the settings differ (spec section 7.2)', () => {
    expect(restartRequired(row({}))).toBe(false);
    expect(restartRequired(row({ allowlist: ['other.com'] }))).toBe(true);
    expect(restartRequired(row({ state: 'starting', language: 'de' }))).toBe(true);
    expect(restartRequired(row({ state: 'stopped', allowlist: ['other.com'] }))).toBe(false);
    expect(restartRequired(row({ state: 'error', allowlist: ['other.com'] }))).toBe(false);
  });
});
