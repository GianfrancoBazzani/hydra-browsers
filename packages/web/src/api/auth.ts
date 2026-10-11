import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MeSchema, type ChangePasswordRequest, type LoginRequest, type Me } from '@hydra/shared';
import { ApiError, apiRequest } from './client';
import { queryKeys } from './keys';

/** The current user, or null without a login session (401). */
export async function fetchMe(signal?: AbortSignal): Promise<Me | null> {
  try {
    return await apiRequest('/api/auth/me', { schema: MeSchema, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: ({ signal }) => fetchMe(signal),
    staleTime: 30_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) =>
      apiRequest('/api/auth/login', { method: 'POST', body: input, schema: MeSchema }),
    onSuccess: (me) => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      queryClient.setQueryData(queryKeys.me, me);
    },
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiRequest('/api/auth/logout', { method: 'POST' }),
    onSettled: () => {
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'me' });
      queryClient.setQueryData(queryKeys.me, null);
    },
  });
}

export function useChangePassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ChangePasswordRequest) =>
      apiRequest('/api/auth/password', { method: 'POST', body: input }),
    onSuccess: () => {
      queryClient.setQueryData<Me | null>(queryKeys.me, (me) =>
        me ? { ...me, mustChangePassword: false } : me,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    },
  });
}
