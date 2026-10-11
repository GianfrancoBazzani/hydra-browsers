import { useInfiniteQuery } from '@tanstack/react-query';
import { AuditPageSchema } from '@hydra/shared';
import { apiRequest } from './client';
import { queryKeys, type AuditFilters } from './keys';

export const AUDIT_PAGE_SIZE = 50;

/** Pages of audit events, newest first. "Load older" fetches the next page. */
export function useAuditPages(sid: string, filters: AuditFilters) {
  return useInfiniteQuery({
    queryKey: queryKeys.audit(sid, filters),
    queryFn: ({ pageParam, signal }) =>
      apiRequest(`/api/sessions/${sid}/audit`, {
        schema: AuditPageSchema,
        signal,
        query: { ...filters, before: pageParam, limit: AUDIT_PAGE_SIZE },
      }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextBefore ?? undefined,
  });
}
