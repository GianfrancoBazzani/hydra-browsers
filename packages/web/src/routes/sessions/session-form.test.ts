import { describe, expect, it } from 'vitest';
import { makeSession } from '../../test/fixtures';
import {
  EMPTY_SESSION_FORM,
  formFromSession,
  serverFieldErrors,
  toCreateRequest,
  toUpdateRequest,
} from './session-form';

describe('session form', () => {
  it('leaves out an empty timezone and language, so the server defaults apply', () => {
    const result = toCreateRequest(
      { ...EMPTY_SESSION_FORM, name: ' Banking ', allowlist: ['example.com'] },
      true,
    );
    expect(result).toEqual({
      ok: true,
      data: { name: 'Banking', allowlist: ['example.com'], screen: '1920x1080', start: true },
    });
  });

  it('reports the fields that fail the shared schema', () => {
    const result = toCreateRequest(
      { ...EMPTY_SESSION_FORM, allowlist: ['*', 'example.com'] },
      true,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.keys(result.errors).sort()).toEqual(['allowlist', 'name']);
    }
  });

  it('puts only the changed fields into the patch', () => {
    const session = makeSession();
    const form = { ...formFromSession(session), screen: '1280x720' as const };
    expect(toUpdateRequest(form, session)).toEqual({ ok: true, data: { screen: '1280x720' } });
    expect(toUpdateRequest(formFromSession(session), session)).toEqual({ ok: true, data: {} });
  });

  it('maps the fields of a validation_failed answer', () => {
    expect(serverFieldErrors({ 'allowlist.2': 'Not a host', other: 'x' })).toEqual({
      allowlist: 'Not a host',
    });
  });
});
