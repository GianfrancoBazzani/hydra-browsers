import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MemberSchema,
  MembersResponseSchema,
  type AddMemberRequest,
  type MemberRole,
} from '@hydra/shared';
import { apiRequest } from './client';
import { queryKeys } from './keys';

export function useMembers(sid: string) {
  return useQuery({
    queryKey: queryKeys.members(sid),
    queryFn: ({ signal }) =>
      apiRequest(`/api/sessions/${sid}/members`, { schema: MembersResponseSchema, signal }),
  });
}

function useMembersMutation<TInput>(sid: string, request: (input: TInput) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.members(sid) }),
  });
}

export function useAddMember(sid: string) {
  return useMembersMutation(sid, (input: AddMemberRequest) =>
    apiRequest(`/api/sessions/${sid}/members`, {
      method: 'POST',
      body: input,
      schema: MemberSchema,
    }),
  );
}

export function useUpdateMember(sid: string) {
  return useMembersMutation(sid, (input: { userId: string; role: MemberRole }) =>
    apiRequest(`/api/sessions/${sid}/members/${input.userId}`, {
      method: 'PATCH',
      body: { role: input.role },
      schema: MemberSchema,
    }),
  );
}

export function useRemoveMember(sid: string) {
  return useMembersMutation(sid, (userId: string) =>
    apiRequest(`/api/sessions/${sid}/members/${userId}`, { method: 'DELETE' }),
  );
}
