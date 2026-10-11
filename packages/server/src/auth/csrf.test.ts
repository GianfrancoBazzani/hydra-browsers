import { describe, expect, it } from 'vitest';
import { HydraError } from '../lib/errors.js';
import { checkCsrf } from './csrf.js';

const ORIGIN = 'https://hydra.example.com';
const good = { origin: ORIGIN, 'content-type': 'application/json' };

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof HydraError ? error.code : 'other';
  }
}

describe('checkCsrf', () => {
  it('skips GET and HEAD', () => {
    expect(codeOf(() => checkCsrf({ method: 'GET', headers: {} }, ORIGIN))).toBeNull();
    expect(codeOf(() => checkCsrf({ method: 'HEAD', headers: {} }, ORIGIN))).toBeNull();
  });

  it('accepts the public origin with JSON, also with a charset', () => {
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: good }, ORIGIN))).toBeNull();
    const headers = { origin: ORIGIN, 'content-type': 'Application/JSON; charset=utf-8' };
    expect(codeOf(() => checkCsrf({ method: 'DELETE', headers }, ORIGIN))).toBeNull();
  });

  it('rejects a missing or different Origin', () => {
    const noOrigin = { 'content-type': 'application/json' };
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: noOrigin }, ORIGIN))).toBe(
      'csrf_failed',
    );
    const live = { ...good, origin: 'https://live.hydra.example.com' };
    expect(codeOf(() => checkCsrf({ method: 'PATCH', headers: live }, ORIGIN))).toBe('csrf_failed');
    const nullOrigin = { ...good, origin: 'null' };
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: nullOrigin }, ORIGIN))).toBe(
      'csrf_failed',
    );
  });

  it('rejects a missing or different Content-Type', () => {
    expect(codeOf(() => checkCsrf({ method: 'POST', headers: { origin: ORIGIN } }, ORIGIN))).toBe(
      'csrf_failed',
    );
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const headers = { origin: ORIGIN, 'content-type': type };
      expect(codeOf(() => checkCsrf({ method: 'POST', headers }, ORIGIN))).toBe('csrf_failed');
    }
  });
});
