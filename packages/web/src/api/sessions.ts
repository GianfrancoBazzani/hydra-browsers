import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LogsResponseSchema,
  SessionResourceSchema,
  type CreateSessionRequest,
  type UpdateSessionRequest,
} from '@hydra/shared';
import { apiRequest } from './client';
import { removeSession, storeSession } from './cache';
import { queryKeys } from './keys';

const SessionListSchema = SessionResourceSchema.array();

/** Own and shared sessions, or all sessions for an admin with `all` (spec section 12.1). */
export function useSessions(options: { all?: boolean } = {}) {
  const all = options.all ?? false;
  return useQuery({
    queryKey: queryKeys.sessionList(all),
    queryFn: ({ signal }) =>
      apiRequest('/api/sessions', {
        schema: SessionListSchema,
        signal,
        ...(all ? { query: { all: 1 } } : {}),
      }),
  });
}

export function useSession(sid: string) {
  return useQuery({
    queryKey: queryKeys.session(sid),
    queryFn: ({ signal }) =>
      apiRequest(`/api/sessions/${sid}`, { schema: SessionResourceSchema, signal }),
  });
}

export function useCreateSession() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSessionRequest) =>
      apiRequest('/api/sessions', { method: 'POST', body: input, schema: SessionResourceSchema }),
    onSuccess: (session) => {
      storeSession(queryClient, session);
    },
    onError: () => {
      // The server creates and starts in one transaction, so a failed start leaves no row. The
      // lists are refreshed anyway after an error, to show the server state.
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessionLists });
    },
  });
}

export function useUpdateSession(sid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSessionRequest) =>
      apiRequest(`/api/sessions/${sid}`, {
        method: 'PATCH',
        body: input,
        schema: SessionResourceSchema,
      }),
    onSuccess: (session) => {
      storeSession(queryClient, session);
    },
  });
}

export type LifecycleAction = 'start' | 'stop' | 'restart';

/** Start, Stop, Restart, and Retry start (spec section 7.9). */
export function useSessionAction(sid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (action: LifecycleAction) =>
      apiRequest(`/api/sessions/${sid}/${action}`, {
        method: 'POST',
        schema: SessionResourceSchema,
      }),
    onSuccess: (session) => {
      storeSession(queryClient, session);
    },
  });
}

export function useDeleteSession(sid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (confirmName: string) =>
      apiRequest(`/api/sessions/${sid}/delete`, { method: 'POST', body: { confirmName } }),
    onSuccess: () => {
      removeSession(queryClient, sid);
    },
  });
}

/** The last 50 log lines of one container (Diagnostics, right `session.logs`). */
export function useLogs(sid: string, container: 'neko' | 'mcp', enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.logs(sid, container),
    queryFn: ({ signal }) =>
      apiRequest(`/api/sessions/${sid}/logs`, {
        schema: LogsResponseSchema,
        query: { container },
        signal,
      }),
    enabled,
    staleTime: 0,
  });
}
