import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createQueryClient } from '../app/query-client';
import { makeMe, makeSession, SID } from '../test/fixtures';
import { apiError, mockApi, type MockApi } from '../test/mock-api';
import { useLogin, useMe } from './auth';
import { queryKeys } from './keys';
import { useSessionAction, useSessions } from './sessions';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
});

function setup() {
  const queryClient = createQueryClient({ retry: false });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
}

describe('API hooks', () => {
  it('useMe gives null without a login session', async () => {
    api.on('GET /api/auth/me', apiError(401, 'unauthenticated', 'Log in'));
    const { wrapper } = setup();
    const { result } = renderHook(() => useMe(), { wrapper });
    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data).toBeNull();
  });

  it('useLogin stores the user', async () => {
    api.on('POST /api/auth/login', { body: makeMe() });
    const { wrapper, queryClient } = setup();
    const { result } = renderHook(() => useLogin(), { wrapper });
    await act(() => result.current.mutateAsync({ email: 'ana@example.com', password: 'x' }));
    expect(queryClient.getQueryData(queryKeys.me)).toEqual(makeMe());
    expect(api.calls('POST /api/auth/login')[0]?.body).toEqual({
      email: 'ana@example.com',
      password: 'x',
    });
  });

  it('useSessions validates the list with the shared schema', async () => {
    api.on('GET /api/sessions', { body: [{ id: SID }] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSessions(), { wrapper });
    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toMatchObject({ code: 'invalid_response' });
  });

  it('useSessions({ all: true }) asks for all sessions', async () => {
    api.on('GET /api/sessions', { body: [makeSession()] });
    const { wrapper } = setup();
    const { result } = renderHook(() => useSessions({ all: true }), { wrapper });
    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });
    expect(api.requests[0]?.query.get('all')).toBe('1');
  });

  it('a 401 from any request ends the login on the client', async () => {
    api.on('POST /api/sessions/q2w3e4r5t6y7/start', apiError(401, 'unauthenticated', 'Log in'));
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(queryKeys.me, makeMe());
    const { result } = renderHook(() => useSessionAction(SID), { wrapper });
    await act(async () => {
      await result.current.mutateAsync('start').catch(() => undefined);
    });
    expect(queryClient.getQueryData(queryKeys.me)).toBeNull();
  });

  it('a lifecycle action stores the returned session', async () => {
    api.on('POST /api/sessions/q2w3e4r5t6y7/stop', { body: makeSession({ state: 'stopping' }) });
    const { wrapper, queryClient } = setup();
    queryClient.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    const { result } = renderHook(() => useSessionAction(SID), { wrapper });
    await act(() => result.current.mutateAsync('stop'));
    expect(queryClient.getQueryData(queryKeys.session(SID))).toMatchObject({ state: 'stopping' });
  });
});
