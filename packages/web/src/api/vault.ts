import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CredentialSchema,
  RevealResponseSchema,
  type CreateCredentialInput,
  type RevealField,
  type UpdateCredentialInput,
} from '@hydra/shared';
import { apiRequest } from './client';
import { queryKeys } from './keys';

const CredentialListSchema = CredentialSchema.array();

export function useCredentials(sid: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.vault(sid),
    queryFn: ({ signal }) =>
      apiRequest(`/api/sessions/${sid}/vault`, { schema: CredentialListSchema, signal }),
    enabled,
  });
}

/** gcTime 0: the values of a request do not stay in the mutation cache. */
function useVaultMutation<TInput, TData>(sid: string, request: (input: TInput) => Promise<TData>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    gcTime: 0,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.vault(sid) }),
  });
}

export function useCreateCredential(sid: string) {
  return useVaultMutation(sid, (input: CreateCredentialInput) =>
    apiRequest(`/api/sessions/${sid}/vault`, {
      method: 'POST',
      body: input,
      schema: CredentialSchema,
    }),
  );
}

export function useUpdateCredential(sid: string) {
  return useVaultMutation(sid, ({ id, input }: { id: string; input: UpdateCredentialInput }) =>
    apiRequest(`/api/sessions/${sid}/vault/${id}`, {
      method: 'PATCH',
      body: input,
      schema: CredentialSchema,
    }),
  );
}

export function useDeleteCredential(sid: string) {
  return useVaultMutation(sid, (id: string) =>
    apiRequest(`/api/sessions/${sid}/vault/${id}`, { method: 'DELETE' }),
  );
}

/** Each call creates one vault.revealed audit event (spec section 6.9.5). gcTime 0 for the value. */
export function useRevealCredential(sid: string) {
  return useMutation({
    mutationFn: ({ id, field }: { id: string; field: RevealField }) =>
      apiRequest(`/api/sessions/${sid}/vault/${id}/reveal`, {
        method: 'POST',
        body: { field },
        schema: RevealResponseSchema,
      }),
    gcTime: 0,
  });
}
