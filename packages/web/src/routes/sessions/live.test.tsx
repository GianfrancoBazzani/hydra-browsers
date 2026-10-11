import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSession, OPERATOR_RIGHTS, SID, SID_2, VIEWER_RIGHTS } from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

function ticketUrl(sid: string, ticket: string) {
  return `http://live.hydra.localhost/s/${sid}/?ticket=${ticket}`;
}

describe('Live view', () => {
  it('opens the iframe with the ticket URL and the attributes of spec section 9.4', async () => {
    mockLoggedIn(api, {
      sessions: [makeSession({ settings: { ...makeSession().settings, screen: '1600x900' } })],
    });
    api.on(`POST /api/sessions/${SID}/live-ticket`, { body: { url: ticketUrl(SID, 't1') } });
    renderApp(`/sessions/${SID}/live`);
    const frame = await screen.findByTitle('Live view of Banking');
    expect(frame).toHaveAttribute('src', ticketUrl(SID, 't1'));
    expect(frame).toHaveAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; autoplay');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-forms allow-pointer-lock',
    );
    expect(frame.style.aspectRatio).toBe('1600 / 900');
    expect(api.calls(`POST /api/sessions/${SID}/live-ticket`)[0]?.body).toEqual({});
  });

  it('shows the banners and the status bar from agentActivity and the allowlist', async () => {
    const session = makeSession({
      settings: { ...makeSession().settings, allowlist: ['*'] },
      agentActivity: {
        activeAgentCount: 2,
        lastToolCall: {
          tool: 'browser_click',
          status: 'ok',
          durationMs: 230,
          startedAt: Date.now(),
        },
      },
    });
    mockLoggedIn(api, { sessions: [session] });
    api.on(`POST /api/sessions/${SID}/live-ticket`, { body: { url: ticketUrl(SID, 't1') } });
    renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByText('Agent active')).toBeInTheDocument();
    expect(screen.getByText('More than one agent is connected')).toBeInTheDocument();
    expect(screen.getByText('Allowlist permits all domains')).toBeInTheDocument();
    expect(screen.getByText('2 agents connected')).toBeInTheDocument();
    expect(screen.getByText('browser_click · ok · 230 ms')).toHaveClass('font-mono');
  });

  it('does not show "Agent active" for an old tool call', async () => {
    const session = makeSession({
      agentActivity: {
        activeAgentCount: 1,
        lastToolCall: {
          tool: 'browser_type',
          status: 'error',
          durationMs: 12,
          startedAt: Date.now() - 60_000,
        },
      },
    });
    mockLoggedIn(api, { sessions: [session] });
    api.on(`POST /api/sessions/${SID}/live-ticket`, { body: { url: ticketUrl(SID, 't1') } });
    renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByText('1 agent connected')).toBeInTheDocument();
    expect(screen.queryByText('Agent active')).not.toBeInTheDocument();
  });

  it('opens the stage in full screen', async () => {
    const requestFullscreen = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: requestFullscreen,
    });
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`POST /api/sessions/${SID}/live-ticket`, { body: { url: ticketUrl(SID, 't1') } });
    const { user } = renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(requestFullscreen.mock.contexts[0]).toBe(screen.getByTestId('live-stage'));
  });

  it('ends the grant of the previous session before it opens another one (spec 9.2)', async () => {
    const other = makeSession({ id: SID_2, name: 'Shop' });
    mockLoggedIn(api, { sessions: [makeSession(), other] });
    api.on(`POST /api/sessions/${SID}/live-ticket`, { body: { url: ticketUrl(SID, 'a') } });
    api.on(`POST /api/sessions/${SID_2}/live-ticket`, { body: { url: ticketUrl(SID_2, 'b') } });
    api.on(`DELETE /api/sessions/${SID}/live-grant`, { status: 204 });
    const { user } = renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    await user.click(screen.getByRole('link', { name: /Shop/ }));
    await screen.findByTitle('Live view of Shop');
    expect(screen.queryByTitle('Live view of Banking')).not.toBeInTheDocument();
    const order = api.requests
      .filter((r) => r.path.includes('live-'))
      .map((r) => `${r.method} ${r.path}`);
    expect(order).toEqual([
      `POST /api/sessions/${SID}/live-ticket`,
      `DELETE /api/sessions/${SID}/live-grant`,
      `POST /api/sessions/${SID_2}/live-ticket`,
    ]);
    expect(api.calls(`DELETE /api/sessions/${SID}/live-grant`)[0]?.body).toEqual({});
  });

  it('gets a new ticket after a reconnect of the user SSE stream', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/live-ticket`,
      { body: { url: ticketUrl(SID, 'first') } },
      { body: { url: ticketUrl(SID, 'second') } },
    );
    renderApp(`/sessions/${SID}/live`);
    const frame = await screen.findByTitle('Live view of Banking');
    expect(frame).toHaveAttribute('src', ticketUrl(SID, 'first'));
    const source = MockEventSource.latest('/api/events');
    act(() => {
      source.open();
      source.drop();
      source.open();
    });
    await waitFor(() => {
      expect(screen.getByTitle('Live view of Banking')).toHaveAttribute(
        'src',
        ticketUrl(SID, 'second'),
      );
    });
  });

  it('gets a new ticket when the live.control right changes', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'operator', rights: OPERATOR_RIGHTS })] });
    api.on(
      `POST /api/sessions/${SID}/live-ticket`,
      { body: { url: ticketUrl(SID, 'operator') } },
      { body: { url: ticketUrl(SID, 'viewer') } },
    );
    const { queryClient } = renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    act(() => {
      queryClient.setQueryData(
        ['sessions', 'detail', SID],
        makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTitle('Live view of Banking')).toHaveAttribute(
        'src',
        ticketUrl(SID, 'viewer'),
      );
    });
  });

  it('removes the iframe while the session restarts and gets a new ticket when it runs again', async () => {
    let state: 'running' | 'starting' = 'running';
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}`, () => ({ body: makeSession({ state }) }));
    api.on(
      `POST /api/sessions/${SID}/live-ticket`,
      { body: { url: ticketUrl(SID, 'before') } },
      { body: { url: ticketUrl(SID, 'after') } },
    );
    renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    const source = MockEventSource.latest('/api/events');
    state = 'starting';
    act(() => {
      source.open();
      source.emit('session.state', { sessionId: SID, state: 'starting', errorReason: null });
    });
    expect(await screen.findByText(/The session is starting/)).toBeInTheDocument();
    expect(screen.queryByTitle('Live view of Banking')).not.toBeInTheDocument();
    state = 'running';
    act(() => {
      source.emit('session.state', { sessionId: SID, state: 'running', errorReason: null });
    });
    expect(await screen.findByTitle('Live view of Banking')).toHaveAttribute(
      'src',
      ticketUrl(SID, 'after'),
    );
  });

  it('shows the state and Start when the session is not running', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ state: 'stopped' })] });
    api.on(`POST /api/sessions/${SID}/start`, { body: makeSession({ state: 'starting' }) });
    const { user } = renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByText('The session is stopped.')).toBeInTheDocument();
    expect(screen.queryByTitle('Live view of Banking')).not.toBeInTheDocument();
    const starts = screen.getAllByRole('button', { name: 'Start' });
    expect(starts).toHaveLength(2);
    await user.click(starts[1] as HTMLElement);
    expect(await screen.findByText(/The session is starting/)).toBeInTheDocument();
    expect(api.calls(`POST /api/sessions/${SID}/live-ticket`)).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeDisabled();
  });

  it('shows the error reason and no Start button to a viewer', async () => {
    mockLoggedIn(api, {
      sessions: [
        makeSession({
          state: 'error',
          errorReason: 'ErrImagePull: not found',
          myRole: 'viewer',
          rights: VIEWER_RIGHTS,
        }),
      ],
    });
    renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByText('ErrImagePull: not found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry start' })).not.toBeInTheDocument();
  });

  it('shows a failed ticket request and tries again', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/live-ticket`,
      apiError(409, 'invalid_state', 'The session is not running.'),
      { body: { url: ticketUrl(SID, 't2') } },
    );
    const { user } = renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('alert')).toHaveTextContent('The session is not running.');
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTitle('Live view of Banking')).toHaveAttribute(
      'src',
      ticketUrl(SID, 't2'),
    );
  });
});
