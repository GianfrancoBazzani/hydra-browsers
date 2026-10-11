import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { formatEventTime } from '../../lib/format';
import {
  makeAuditEvent,
  makeSession,
  makeToken,
  SID,
  T0,
  VIEWER_RIGHTS,
} from '../../test/fixtures';
import { apiError, mockApi, type MockApi, type RecordedRequest } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

const FIRST_PAGE = {
  events: [
    makeAuditEvent({ id: 12 }),
    makeAuditEvent({
      id: 11,
      kind: 'session.state',
      actorType: 'system',
      actorId: null,
      actorName: null,
      status: null,
      data: { state: 'running' },
    }),
  ],
  nextBefore: 11,
};
const OLDER_PAGE = {
  events: [makeAuditEvent({ id: 3, data: { tool: 'browser_navigate', durationMs: 900 } })],
  nextBefore: null,
};

function auditAnswer(request: RecordedRequest) {
  return { body: request.query.get('before') === '11' ? OLDER_PAGE : FIRST_PAGE };
}

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
  api.on(`GET /api/sessions/${SID}/tokens`, { body: [makeToken()] });
});

function rows() {
  const table = screen.getByRole('table', { name: 'Activity' });
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => row.textContent);
}

describe('Activity view', () => {
  it('lists events, loads older pages, and adds live events from the session SSE stream', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/audit`, auditAnswer);
    const { user } = renderApp(`/sessions/${SID}/activity`);
    expect(await screen.findByText('browser_click · 230 ms')).toBeInTheDocument();
    expect(screen.getByText('laptop (token)')).toBeInTheDocument();
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(api.calls(`GET /api/sessions/${SID}/audit`)[0]?.query.toString()).toBe('limit=50');

    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText('browser_navigate · 900 ms')).toBeInTheDocument();
    expect(api.calls(`GET /api/sessions/${SID}/audit`)[1]?.query.get('before')).toBe('11');
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();

    const source = MockEventSource.latest(`/api/sessions/${SID}/events`);
    act(() => {
      source.open();
      source.emit(
        'audit',
        makeAuditEvent({ id: 13, status: 'pending', data: { tool: 'browser_type' } }),
      );
    });
    await waitFor(() => {
      expect(rows()[0]).toContain('browser_type');
    });
    expect(rows()).toHaveLength(4);
  });

  it('sends the filters to the server', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/audit`, { body: { events: [], nextBefore: null } });
    const { user } = renderApp(`/sessions/${SID}/activity`);
    expect(await screen.findByRole('cell', { name: 'No events' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Kind: All kinds' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'mcp.tool_call' }));
    await user.type(screen.getByLabelText('Tool'), 'browser_click{Enter}');
    await user.click(screen.getByRole('button', { name: 'Status: Any status' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'error' }));
    await user.click(await screen.findByRole('button', { name: 'Token: Any token' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'laptop' }));

    await waitFor(() => {
      const last = api.calls(`GET /api/sessions/${SID}/audit`).at(-1);
      expect(Object.fromEntries(last?.query ?? [])).toEqual({
        kind: 'mcp.tool_call',
        tool: 'browser_click',
        status: 'error',
        tokenId: makeToken().id,
        limit: '50',
      });
    });
  });

  it('shows the data of a clicked row', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/audit`, auditAnswer);
    const { user } = renderApp(`/sessions/${SID}/activity`);
    await user.click(await screen.findByText('browser_click · 230 ms'));
    const sheet = await screen.findByRole('dialog', { name: /^mcp\.tool_call · / });
    const data = within(sheet).getByRole('figure', { name: 'Event data' }).textContent;
    expect(JSON.parse(data)).toEqual({ tool: 'browser_click', durationMs: 230 });
  });

  it('opens the details with the keyboard, through the Time button', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const first = makeAuditEvent({ id: 12, ts: T0 + 2000 });
    const second = makeAuditEvent({
      id: 11,
      ts: T0 + 1000,
      data: { tool: 'browser_type', durationMs: 40 },
    });
    api.on(`GET /api/sessions/${SID}/audit`, {
      body: { events: [first, second], nextBefore: null },
    });
    const { user } = renderApp(`/sessions/${SID}/activity`);
    const button = await screen.findByRole('button', {
      name: `Open mcp.tool_call event at ${formatEventTime(second.ts)}`,
    });
    for (let i = 0; i < 20 && document.activeElement !== button; i += 1) {
      await user.tab();
    }
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');
    const sheet = await screen.findByRole('dialog', { name: /^mcp\.tool_call · / });
    const data = within(sheet).getByRole('figure', { name: 'Event data' }).textContent;
    expect(JSON.parse(data)).toEqual({ tool: 'browser_type', durationMs: 40 });
  });

  it('updates the open details when a live event replaces the same ID', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const pending = makeAuditEvent({ id: 12, status: 'pending', data: { tool: 'browser_click' } });
    api.on(`GET /api/sessions/${SID}/audit`, { body: { events: [pending], nextBefore: null } });
    const { user } = renderApp(`/sessions/${SID}/activity`);
    await user.click(await screen.findByRole('button', { name: /^Open mcp\.tool_call event at / }));
    const sheet = await screen.findByRole('dialog', { name: /^mcp\.tool_call · / });
    expect(within(sheet).getByText('laptop (token) · pending')).toBeInTheDocument();

    const source = MockEventSource.latest(`/api/sessions/${SID}/events`);
    act(() => {
      source.open();
      source.emit(
        'audit',
        makeAuditEvent({ id: 12, status: 'ok', data: { tool: 'browser_click', durationMs: 500 } }),
      );
    });
    expect(await within(sheet).findByText('laptop (token) · ok')).toBeInTheDocument();
    const data = within(sheet).getByRole('figure', { name: 'Event data' }).textContent;
    expect(JSON.parse(data)).toEqual({ tool: 'browser_click', durationMs: 500 });
  });

  it('replaces a row with the same ID instead of adding one', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const pending = makeAuditEvent({ id: 12, status: 'pending', data: { tool: 'browser_click' } });
    api.on(`GET /api/sessions/${SID}/audit`, { body: { events: [pending], nextBefore: null } });
    renderApp(`/sessions/${SID}/activity`);
    await screen.findByText('browser_click');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toContain('pending');

    const source = MockEventSource.latest(`/api/sessions/${SID}/events`);
    act(() => {
      source.open();
      source.emit(
        'audit',
        makeAuditEvent({ id: 12, status: 'ok', data: { tool: 'browser_click', durationMs: 230 } }),
      );
    });
    await waitFor(() => {
      expect(rows()[0]).toContain('browser_click · 230 ms');
    });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).not.toContain('pending');
  });

  it('shows the error of a failed Load older and keeps the loaded rows', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/audit`, (request) =>
      request.query.get('before') === '11'
        ? apiError(500, 'internal', 'Could not load older events.')
        : { body: FIRST_PAGE },
    );
    const { user } = renderApp(`/sessions/${SID}/activity`);
    expect(await screen.findByText('browser_click · 230 ms')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load older events.');
    expect(rows()).toHaveLength(2);
    expect(screen.getByText('browser_click · 230 ms')).toBeInTheDocument();
  });

  it('shows the error of a failed load', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `GET /api/sessions/${SID}/audit`,
      apiError(403, 'forbidden', 'You cannot read the audit log.'),
    );
    renderApp(`/sessions/${SID}/activity`);
    expect(await screen.findByRole('alert')).toHaveTextContent('You cannot read the audit log.');
  });

  it('is not open to a viewer (no audit.read)', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    const { router } = renderApp(`/sessions/${SID}/activity`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    });
    expect(api.calls(`GET /api/sessions/${SID}/audit`)).toHaveLength(0);
    expect(MockEventSource.instances.map((s) => s.url)).not.toContain(
      `/api/sessions/${SID}/events`,
    );
  });

  it('leaves the view and closes its stream after audit.read is lost (spec 6.5)', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `GET /api/sessions/${SID}`,
      { body: makeSession() },
      { body: makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS }) },
    );
    api.on(`GET /api/sessions/${SID}/audit`, auditAnswer);
    api.on(`POST /api/sessions/${SID}/live-ticket`, {
      body: { url: `http://live.hydra.localhost/s/${SID}/?ticket=t1` },
    });
    const { router } = renderApp(`/sessions/${SID}/activity`);
    expect(await screen.findByText('browser_click · 230 ms')).toBeInTheDocument();
    const sessionSource = MockEventSource.latest(`/api/sessions/${SID}/events`);
    const userSource = MockEventSource.latest('/api/events');
    // The gateway ends both streams after the rights change. The browser reconnects them.
    act(() => {
      sessionSource.open();
      userSource.open();
      sessionSource.end();
      userSource.end();
      userSource.open();
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    });
    expect(sessionSource.readyState).toBe(MockEventSource.CLOSED);
    // The refetch after the reconnect happened, and no session stream is left open.
    expect(api.calls(`GET /api/sessions/${SID}`).length).toBeGreaterThanOrEqual(2);
    const sessionStreams = MockEventSource.instances.filter(
      (s) => s.url === `/api/sessions/${SID}/events`,
    );
    expect(sessionStreams.length).toBeGreaterThan(0);
    for (const stream of sessionStreams) expect(stream.readyState).toBe(MockEventSource.CLOSED);
    expect(userSource.readyState).toBe(MockEventSource.OPEN);
  });
});
