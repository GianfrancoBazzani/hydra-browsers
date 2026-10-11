import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import { queryKeys } from '../api/keys';

function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

/**
 * The TanStack Query client. A 401 anywhere ends the login on the client (the route guard then
 * opens Login). A `password_change_required` 403 loads the user again, so the guard opens
 * Change password.
 */
export function createQueryClient(options: { retry?: boolean } = {}): QueryClient {
  const handleAuthError = (error: unknown) => {
    if (!(error instanceof ApiError)) return;
    if (error.code === 'unauthenticated') {
      queryClient.setQueryData(queryKeys.me, null);
    } else if (error.code === 'password_change_required') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.me });
    }
  };
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: handleAuthError }),
    mutationCache: new MutationCache({ onError: handleAuthError }),
    defaultOptions: {
      queries: {
        retry: options.retry === false ? false : shouldRetry,
        staleTime: 5_000,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: false },
    },
  });
  return queryClient;
}
