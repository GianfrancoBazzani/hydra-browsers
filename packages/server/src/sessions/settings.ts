import type { SessionSettings } from '@hydra/shared';
import type { SessionRow } from '../db/schema.js';
import { screenOf, stateOf } from '../orchestrator/row-fields.js';

/** The settings of the row. Start and Restart copy them to applied_settings (spec section 7.2). */
export function currentSettings(row: SessionRow): SessionSettings {
  return {
    allowlist: [...row.allowlist],
    timezone: row.timezone,
    language: row.language,
    screen: screenOf(row),
  };
}

export function sameSettings(a: SessionSettings, b: SessionSettings): boolean {
  return (
    a.timezone === b.timezone &&
    a.language === b.language &&
    a.screen === b.screen &&
    a.allowlist.length === b.allowlist.length &&
    a.allowlist.every((entry, index) => entry === b.allowlist[index])
  );
}

/** Spec section 7.2: the session has a pod (state starting or running) and the settings differ. */
export function restartRequired(row: SessionRow): boolean {
  const state = stateOf(row);
  return (
    (state === 'starting' || state === 'running') &&
    !sameSettings(currentSettings(row), row.appliedSettings)
  );
}
