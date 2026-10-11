import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CreateUserResponseSchema,
  ResetPasswordResponseSchema,
  UserSummarySchema,
  type CreateUserRequest,
  type UpdateUserRequest,
} from '@hydra/shared';
import { apiRequest } from './client';
import { queryKeys } from './keys';

const UserListSchema = UserSummarySchema.array();

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => apiRequest('/api/users', { schema: UserListSchema, signal }),
  });
}

/**
 * `oneTime` results (one-time passwords) use `gcTime: 0`, so that they leave the mutation cache
 * as soon as no sheet observes them.
 */
function useUsersMutation<TInput, TOutput>(
  request: (input: TInput) => Promise<TOutput>,
  options: { oneTime?: boolean } = {},
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    ...(options.oneTime ? { gcTime: 0 } : {}),
    // The refetch is not returned: TanStack would await it, and a one-time password would reach the
    // sheet only after the list answers.
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.users });
    },
  });
}

/** Returns the one-time password (spec section 6.3). */
export function useCreateUser() {
  return useUsersMutation(
    (input: CreateUserRequest) =>
      apiRequest('/api/users', { method: 'POST', body: input, schema: CreateUserResponseSchema }),
    { oneTime: true },
  );
}

export function useUpdateUser() {
  return useUsersMutation((input: { userId: string; patch: UpdateUserRequest }) =>
    apiRequest(`/api/users/${input.userId}`, {
      method: 'PATCH',
      body: input.patch,
      schema: UserSummarySchema,
    }),
  );
}

export function useResetPassword() {
  return useUsersMutation(
    (userId: string) =>
      apiRequest(`/api/users/${userId}/reset-password`, {
        method: 'POST',
        schema: ResetPasswordResponseSchema,
      }),
    { oneTime: true },
  );
}

export function useUnlockUser() {
  return useUsersMutation((userId: string) =>
    apiRequest(`/api/users/${userId}/unlock`, { method: 'POST', schema: UserSummarySchema }),
  );
}
