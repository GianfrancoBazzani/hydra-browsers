import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import type { AuditEvent, AuditPage, SessionResource } from '@hydra/shared';
import { queryKeys, type AuditFilters } from './keys';

function sessionListKeys(queryClient: QueryClient) {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: queryKeys.sessionLists })
    .map((query) => query.queryKey);
}

/** Puts a session from an API response into the detail cache and into each cached list. */
export function storeSession(queryClient: QueryClient, session: SessionResource): void {
  queryClient.setQueryData(queryKeys.session(session.id), session);
  for (const key of sessionListKeys(queryClient)) {
    queryClient.setQueryData<SessionResource[]>(key, (list) => {
      if (!list) return list;
      return list.some((s) => s.id === session.id)
        ? list.map((s) => (s.id === session.id ? session : s))
        : [...list, session];
    });
  }
}

/**
 * Changes fields of a cached session (SSE events). Returns false when no cached list has the
 * session, so the caller can fetch the lists again.
 */
export function patchSession(
  queryClient: QueryClient,
  sid: string,
  patch: Partial<Pick<SessionResource, 'state' | 'errorReason' | 'agentActivity'>>,
): boolean {
  queryClient.setQueryData<SessionResource>(queryKeys.session(sid), (session) =>
    session ? { ...session, ...patch } : session,
  );
  let found = false;
  for (const key of sessionListKeys(queryClient)) {
    queryClient.setQueryData<SessionResource[]>(key, (list) => {
      if (!list?.some((s) => s.id === sid)) return list;
      found = true;
      return list.map((s) => (s.id === sid ? { ...s, ...patch } : s));
    });
  }
  return found;
}

/**
 * Removes a deleted session from the lists. The detail keeps the state `deleted`, so an open
 * session page updates at once (removing an observed query would not re-render it).
 */
export function removeSession(queryClient: QueryClient, sid: string): void {
  for (const key of sessionListKeys(queryClient)) {
    queryClient.setQueryData<SessionResource[]>(key, (list) => list?.filter((s) => s.id !== sid));
  }
  queryClient.setQueryData<SessionResource>(queryKeys.session(sid), (session) =>
    session ? { ...session, state: 'deleted' } : session,
  );
  queryClient.removeQueries({ queryKey: queryKeys.members(sid) });
  queryClient.removeQueries({ queryKey: queryKeys.tokens(sid) });
  queryClient.removeQueries({ queryKey: queryKeys.auditAll(sid) });
}

/** The client-side copy of the server filters, for events that arrive on the SSE stream. */
export function auditEventMatches(event: AuditEvent, filters: AuditFilters): boolean {
  if (filters.kind !== undefined && event.kind !== filters.kind) return false;
  if (filters.status !== undefined && event.status !== filters.status) return false;
  if (filters.tool !== undefined && event.data.tool !== filters.tool) return false;
  if (
    filters.tokenId !== undefined &&
    !(event.actorType === 'token' && event.actorId === filters.tokenId) &&
    event.data.tokenId !== filters.tokenId
  ) {
    return false;
  }
  return true;
}

/**
 * Adds or replaces an audit event in each cached Activity query of the session. An event with a
 * known ID replaces the old copy (a `pending` tool call that is now `ok`), or leaves the query
 * when it no longer matches its filters.
 */
export function addAuditEvent(queryClient: QueryClient, sid: string, event: AuditEvent): void {
  const queries = queryClient.getQueryCache().findAll({ queryKey: queryKeys.auditAll(sid) });
  for (const query of queries) {
    const filters = (query.queryKey[3] ?? {}) as AuditFilters;
    const matches = auditEventMatches(event, filters);
    queryClient.setQueryData<InfiniteData<AuditPage, number | undefined>>(
      query.queryKey,
      (data) => {
        if (!data) return data;
        const known = data.pages.some((page) => page.events.some((e) => e.id === event.id));
        if (known) {
          return {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              events: matches
                ? page.events.map((e) => (e.id === event.id ? event : e))
                : page.events.filter((e) => e.id !== event.id),
            })),
          };
        }
        if (!matches) return data;
        const [first, ...rest] = data.pages;
        if (!first) return data;
        return { ...data, pages: [{ ...first, events: [event, ...first.events] }, ...rest] };
      },
    );
  }
}
