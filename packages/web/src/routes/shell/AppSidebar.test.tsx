import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  makeMe,
  makeSession,
  OPERATOR_RIGHTS,
  SID,
  SID_2,
  VIEWER_RIGHTS,
} from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

const SESSIONS = [
  makeSession({ name: 'Banking', state: 'running' }),
  makeSession({
    id: SID_2,
    name: 'Shop',
    state: 'stopped',
    myRole: 'viewer',
    rights: VIEWER_RIGHTS,
  }),
  makeSession({
    id: 'a2b3c4d5e6f7',
    name: 'Support',
    state: 'error',
    myRole: 'operator',
    rights: OPERATOR_RIGHTS,
  }),
];

describe('Sidebar', () => {
  it('lists own and shared sessions with their state', async () => {
    mockLoggedIn(api, { sessions: SESSIONS });
    renderApp('/');
    const mine = await screen.findByRole('region', { name: 'My sessions' });
    expect(await within(mine).findByRole('link', { name: /Banking/ })).toHaveTextContent(
      'RunningBanking',
    );
    const shared = screen.getByRole('region', { name: 'Shared with me' });
    expect(
      within(shared)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['StoppedShop', 'ErrorSupport']);
    expect(screen.queryByRole('region', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('shows the Admin section to admins', async () => {
    mockLoggedIn(api, { me: makeMe({ role: 'admin' }) });
    renderApp('/');
    const admin = await screen.findByRole('region', { name: 'Admin' });
    expect(within(admin).getByRole('link', { name: 'Users' })).toHaveAttribute(
      'href',
      '/admin/users',
    );
    expect(within(admin).getByRole('link', { name: 'All sessions' })).toHaveAttribute(
      'href',
      '/admin/sessions',
    );
  });

  it('updates the state and the agent icon from the user SSE stream', async () => {
    mockLoggedIn(api, { sessions: SESSIONS });
    renderApp('/');
    const link = await screen.findByRole('link', { name: /Banking/ });
    const source = MockEventSource.latest('/api/events');
    act(() => {
      source.open();
      source.emit('session.state', { sessionId: SID, state: 'stopping', errorReason: null });
      source.emit('session.activity', {
        sessionId: SID,
        agentActivity: { activeAgentCount: 1, lastToolCall: null },
      });
    });
    await waitFor(() => {
      expect(link).toHaveTextContent('StoppingBankingAgent connected');
    });
  });

  it('logs out from the user menu', async () => {
    mockLoggedIn(api);
    api.on('POST /api/auth/logout', { status: 204 });
    const { user, router } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Ana/ }));
    expect(await screen.findByText('ana@example.com')).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(api.calls('POST /api/auth/logout')[0]?.body).toEqual({});
  });

  it('opens Change password from the user menu', async () => {
    mockLoggedIn(api);
    const { user, router } = renderApp('/');
    await user.click(await screen.findByRole('button', { name: /Ana/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change password' }));
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('says when the sessions cannot be loaded', async () => {
    api.on('GET /api/auth/me', { body: makeMe() });
    api.on('GET /api/sessions', apiError(500, 'internal', 'Internal server error.'));
    renderApp('/');
    expect(await screen.findByText('The sessions cannot be loaded.')).toBeInTheDocument();
  });
});
