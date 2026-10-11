import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CreateTokenResponseSchema, TokenSchema, type CreateTokenRequest } from '@hydra/shared';
import { apiRequest } from './client';
import { queryKeys } from './keys';

const TokenListSchema = TokenSchema.array();

export function useTokens(sid: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tokens(sid),
    queryFn: ({ signal }) =>
      apiRequest(`/api/sessions/${sid}/tokens`, { schema: TokenListSchema, signal }),
    enabled,
  });
}

/**
 * Returns the token secret one time (spec section 6.6). `gcTime: 0` removes the result from the
 * mutation cache as soon as no sheet observes it, so that the secret does not stay in memory.
 */
export function useCreateToken(sid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTokenRequest) =>
      apiRequest(`/api/sessions/${sid}/tokens`, {
        method: 'POST',
        body: input,
        schema: CreateTokenResponseSchema,
      }),
    gcTime: 0,
    // The refetch is not returned: TanStack would await it, and the one-time secret would reach the
    // sheet only after the list answers.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tokens(sid) });
    },
  });
}

export function useRevokeToken(sid: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (tokenId: string) =>
      apiRequest(`/api/sessions/${sid}/tokens/${tokenId}`, { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.tokens(sid) }),
  });
}
