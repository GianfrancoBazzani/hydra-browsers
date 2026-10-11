import { QueryClient, type InfiniteData } from '@tanstack/react-query';
import type { AuditPage, SessionResource } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import { makeAuditEvent, makeSession, SID, SID_2 } from '../test/fixtures';
import { addAuditEvent, patchSession, removeSession, storeSession } from './cache';
import { queryKeys } from './keys';

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('session cache', () => {
  it('patches the detail and every list that has the session', () => {
    const qc = client();
    qc.setQueryData(queryKeys.sessionList(false), [makeSession(), makeSession({ id: SID_2 })]);
    qc.setQueryData(queryKeys.sessionList(true), [makeSession()]);
    qc.setQueryData(queryKeys.session(SID), makeSession());
    const found = patchSession(qc, SID, { state: 'stopping' });
    expect(found).toBe(true);
    expect(qc.getQueryData<SessionResource>(queryKeys.session(SID))?.state).toBe('stopping');
    expect(qc.getQueryData<SessionResource[]>(queryKeys.sessionList(false))?.[0]?.state).toBe(
      'stopping',
    );
    expect(qc.getQueryData<SessionResource[]>(queryKeys.sessionList(false))?.[1]?.state).toBe(
      'running',
    );
    expect(qc.getQueryData<SessionResource[]>(queryKeys.sessionList(true))?.[0]?.state).toBe(
      'stopping',
    );
  });

  it('reports an unknown session', () => {
    const qc = client();
    qc.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    expect(patchSession(qc, SID_2, { state: 'running' })).toBe(false);
  });

  it('stores a new session in the lists, and marks a deleted one', () => {
    const qc = client();
    qc.setQueryData(queryKeys.sessionList(false), [makeSession()]);
    qc.setQueryData(queryKeys.session(SID), makeSession());
    storeSession(qc, makeSession({ id: SID_2, name: 'Shop' }));
    expect(qc.getQueryData<SessionResource[]>(queryKeys.sessionList(false))).toHaveLength(2);
    removeSession(qc, SID);
    expect(
      qc.getQueryData<SessionResource[]>(queryKeys.sessionList(false))?.map((s) => s.id),
    ).toEqual([SID_2]);
    expect(qc.getQueryData<SessionResource>(queryKeys.session(SID))?.state).toBe('deleted');
  });
});

describe('addAuditEvent', () => {
  function seed(qc: QueryClient, filters: Parameters<typeof queryKeys.audit>[1]) {
    const data: InfiniteData<AuditPage, number | undefined> = {
      pages: [{ events: [makeAuditEvent({ id: 5, status: 'pending' })], nextBefore: null }],
      pageParams: [undefined],
    };
    qc.setQueryData(queryKeys.audit(SID, filters), data);
  }
  function events(qc: QueryClient, filters: Parameters<typeof queryKeys.audit>[1]) {
    return qc
      .getQueryData<InfiniteData<AuditPage>>(queryKeys.audit(SID, filters))
      ?.pages.flatMap((p) => p.events.map((e) => `${String(e.id)}:${e.status ?? '-'}`));
  }

  it('prepends a new event that matches the filters', () => {
    const qc = client();
    seed(qc, {});
    seed(qc, { kind: 'session.state' });
    addAuditEvent(qc, SID, makeAuditEvent({ id: 6 }));
    expect(events(qc, {})).toEqual(['6:ok', '5:pending']);
    expect(events(qc, { kind: 'session.state' })).toEqual(['5:pending']);
  });

  it('replaces a known event, and removes it where it no longer matches', () => {
    const qc = client();
    seed(qc, {});
    seed(qc, { status: 'pending' });
    addAuditEvent(qc, SID, makeAuditEvent({ id: 5, status: 'ok' }));
    expect(events(qc, {})).toEqual(['5:ok']);
    expect(events(qc, { status: 'pending' })).toEqual([]);
  });

  it('matches the tool and token filters', () => {
    const qc = client();
    seed(qc, { tool: 'browser_type', tokenId: 'other' });
    addAuditEvent(qc, SID, makeAuditEvent({ id: 7 }));
    expect(events(qc, { tool: 'browser_type', tokenId: 'other' })).toEqual(['5:pending']);
  });
});
