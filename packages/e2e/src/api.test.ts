import type { SessionResource } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import { deleteLeftoverSessions, errorCode, type ApiResult, type Method } from './api.js';

describe('errorCode', () => {
  it('reads the code of an API error body', () => {
    expect(errorCode({ error: { code: 'not_found', message: 'Not found' } })).toBe('not_found');
  });

  it('returns null for other bodies', () => {
    expect(errorCode(null)).toBeNull();
    expect(errorCode({ error: 'not_found' })).toBeNull();
    expect(errorCode({ id: 'abc' })).toBeNull();
  });
});

describe('deleteLeftoverSessions', () => {
  it('deletes only the e2e sessions, ignores a 404, and waits until each is gone', async () => {
    const calls: string[] = [];
    const sessions = [
      { id: 's1', name: 'e2e-a-mabc' },
      { id: 's2', name: 'Team research' },
      { id: 's3', name: 'e2e-main-mabc' },
    ] as unknown as SessionResource[];
    const api = {
      listSessions: (all: boolean): Promise<SessionResource[]> => {
        calls.push(`list all=${String(all)}`);
        return Promise.resolve(sessions);
      },
      call: (method: Method, path: string, data?: unknown): Promise<ApiResult> => {
        calls.push(`${method} ${path} ${JSON.stringify(data)}`);
        return Promise.resolve({ status: path.includes('s3') ? 404 : 204, text: '', json: null });
      },
      waitForGone: (sid: string): Promise<void> => {
        calls.push(`gone ${sid}`);
        return Promise.resolve();
      },
    };
    expect(await deleteLeftoverSessions(api)).toEqual(['s1', 's3']);
    expect(calls).toEqual([
      'list all=true',
      'POST /api/sessions/s1/delete {"confirmName":"e2e-a-mabc"}',
      'POST /api/sessions/s3/delete {"confirmName":"e2e-main-mabc"}',
      'gone s1',
      'gone s3',
    ]);
  });
});
