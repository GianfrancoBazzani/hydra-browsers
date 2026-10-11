import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeMe, makeSession, SID } from '../test/fixtures';
import { apiError, mockApi, type MockApi } from '../test/mock-api';
import { MockEventSource } from '../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

describe('Change password', () => {
  it('is the only screen while mustChangePassword is true, and opens the app after it', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    // The first answer has the one-time password flag, the answers after the change do not.
    api.on('GET /api/auth/me', { body: makeMe({ mustChangePassword: true }) }, { body: makeMe() });
    api.on('POST /api/auth/password', { status: 204 });
    const { user, router } = renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/change-password');
    expect(screen.queryByRole('navigation', { name: 'Sidebar' })).not.toBeInTheDocument();
    expect(MockEventSource.instances).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Log out' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Current password'), 'one-time-password');
    await user.type(screen.getByLabelText('New password'), 'a long new password');
    await user.type(screen.getByLabelText('Repeat the new password'), 'a long new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));

    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
    expect(api.calls('POST /api/auth/password')[0]?.body).toEqual({
      current: 'one-time-password',
      new: 'a long new password',
    });
  });

  it('checks the length and the repeat before it sends the request', async () => {
    mockLoggedIn(api, { me: makeMe({ mustChangePassword: true }) });
    const { user } = renderApp('/change-password');
    await user.type(await screen.findByLabelText('Current password'), 'old');
    await user.type(screen.getByLabelText('New password'), 'short');
    await user.type(screen.getByLabelText('Repeat the new password'), 'short');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('12 to 128 characters');
    await user.clear(screen.getByLabelText('New password'));
    await user.type(screen.getByLabelText('New password'), 'a long new password');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('not the same');
    expect(api.calls('POST /api/auth/password')).toHaveLength(0);
  });

  it('counts the length in code points, like the server, not in UTF-16 units', async () => {
    mockLoggedIn(api, { me: makeMe({ mustChangePassword: true }) });
    api.on('POST /api/auth/password', { status: 204 });
    const { user } = renderApp('/change-password');
    await user.type(await screen.findByLabelText('Current password'), 'old');
    // 11 emoji are 22 UTF-16 units but 11 characters: too short.
    const eleven = '😀'.repeat(11);
    await user.click(screen.getByLabelText('New password'));
    await user.paste(eleven);
    await user.click(screen.getByLabelText('Repeat the new password'));
    await user.paste(eleven);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(screen.getByRole('alert')).toHaveTextContent('12 to 128 characters');
    expect(api.calls('POST /api/auth/password')).toHaveLength(0);

    // 100 emoji are 200 UTF-16 units but 100 characters: within 12 to 128.
    const hundred = '😀'.repeat(100);
    await user.clear(screen.getByLabelText('New password'));
    await user.click(screen.getByLabelText('New password'));
    await user.paste(hundred);
    await user.clear(screen.getByLabelText('Repeat the new password'));
    await user.click(screen.getByLabelText('Repeat the new password'));
    await user.paste(hundred);
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    await waitFor(() => {
      expect(api.calls('POST /api/auth/password')).toHaveLength(1);
    });
    expect(api.calls('POST /api/auth/password')[0]?.body).toEqual({ current: 'old', new: hundred });
  });

  it('shows the password_rejected message of the server', async () => {
    mockLoggedIn(api);
    api.on(
      'POST /api/auth/password',
      apiError(400, 'password_rejected', 'This password is too common.'),
    );
    const { user } = renderApp('/change-password');
    expect(await screen.findByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Current password'), 'old password 1');
    await user.type(screen.getByLabelText('New password'), 'password1234');
    await user.type(screen.getByLabelText('Repeat the new password'), 'password1234');
    await user.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This password is too common.');
  });
});
