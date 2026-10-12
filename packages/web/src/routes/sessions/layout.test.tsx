import { act, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeMe, makeSession, SID, VIEWER_RIGHTS } from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
  api.on(`POST /api/sessions/${SID}/live-ticket`, {
    body: { url: `http://live.hydra.localhost/s/${SID}/?ticket=t1` },
  });
});

function views() {
  return within(screen.getByRole('radiogroup', { name: 'Views' }))
    .getAllByRole('radio')
    .map((radio) => radio.textContent);
}

describe('Session toolbar', () => {
  it('shows all views and the lifecycle buttons to the owner', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`POST /api/sessions/${SID}/stop`, { body: makeSession({ state: 'stopping' }) });
    const { user } = renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Banking' })).toBeInTheDocument();
    expect(views()).toEqual(['Live', 'Tokens', 'Vault', 'Sharing', 'Activity', 'Settings']);
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    await waitFor(() => {
      expect(screen.getByRole('banner')).toHaveTextContent('Stopping');
    });
    expect(api.calls(`POST /api/sessions/${SID}/stop`)[0]?.body).toEqual({});
    expect(screen.getByRole('button', { name: 'Stop' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart' })).toBeDisabled();
  });

  it('shows Retry start for a session in error, and the error of a failed start', async () => {
    mockLoggedIn(api, {
      sessions: [makeSession({ state: 'error', errorReason: 'ImagePullBackOff' })],
    });
    api.on(
      `POST /api/sessions/${SID}/start`,
      apiError(409, 'capacity_reached', '10 sessions hold a media port.'),
    );
    const { user } = renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Banking' })).toBeInTheDocument();
    const toolbar = screen.getByRole('banner');
    await user.click(within(toolbar).getByRole('button', { name: 'Retry start' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('10 sessions hold a media port.');
  });

  it('opens the URL of a view with the segmented control', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const { user, router } = renderApp(`/sessions/${SID}/live`);
    await user.click(await screen.findByRole('radio', { name: 'Sharing' }));
    expect(router.state.location.pathname).toBe(`/sessions/${SID}/sharing`);
  });

  it('limits a viewer to the views and buttons of the viewer rights', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('radiogroup', { name: 'Views' })).toBeInTheDocument();
    expect(views()).toEqual(['Live', 'Vault', 'Sharing', 'Settings']);
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'More' })).not.toBeInTheDocument();
  });

  it('opens the first allowed view for /sessions/:sid', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const { router } = renderApp(`/sessions/${SID}`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    });
  });

  it('shows Not found for a session without access (404)', async () => {
    mockLoggedIn(api);
    api.on(`GET /api/sessions/${SID}`, apiError(404, 'not_found', 'Not found'));
    renderApp(`/sessions/${SID}/live`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
  });
});

describe('Session page edge cases', () => {
  it('opens Login when the login ends, and returns to the page after the next login', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`POST /api/sessions/${SID}/stop`, apiError(401, 'unauthenticated', 'Log in again.'));
    api.on('POST /api/auth/login', { body: makeMe() });
    const { user, router } = renderApp(`/sessions/${SID}/live`);
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    await user.type(screen.getByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Banking' })).toBeInTheDocument();
  });

  it('shows Not found when the open session is deleted elsewhere', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    const source = MockEventSource.latest('/api/events');
    act(() => {
      source.open();
      source.emit('session.state', { sessionId: SID, state: 'deleted', errorReason: null });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(screen.queryByTitle('Live view of Banking')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Banking/ })).not.toBeInTheDocument();
  });

  it('shows Not found when the user loses access to the open session (spec 6.5)', async () => {
    const shared = makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS });
    mockLoggedIn(api, { sessions: [shared] });
    api.on('GET /api/sessions', { body: [shared] }, { body: [] });
    api.on(`GET /api/sessions/${SID}`, { body: shared }, apiError(404, 'not_found', 'Not found'));
    renderApp(`/sessions/${SID}/live`);
    await screen.findByTitle('Live view of Banking');
    // The owner removed the user: the gateway ends GET /api/events, the browser reconnects.
    const source = MockEventSource.latest('/api/events');
    act(() => {
      source.open();
      source.end();
      source.open();
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /Banking/ })).not.toBeInTheDocument();
    });
  });
});

describe('Delete sheet', () => {
  it('deletes only after the exact session name, then opens the start page', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`POST /api/sessions/${SID}/delete`, { status: 204 });
    const { user, router } = renderApp(`/sessions/${SID}/live`);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete “Banking”?' });
    const remove = within(dialog).getByRole('button', { name: 'Delete' });
    expect(remove).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Type the session name to confirm'), 'banking');
    expect(remove).toBeDisabled();
    await user.clear(within(dialog).getByLabelText('Type the session name to confirm'));
    await user.type(within(dialog).getByLabelText('Type the session name to confirm'), 'Banking');
    await user.click(remove);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/');
    });
    expect(api.calls(`POST /api/sessions/${SID}/delete`)[0]?.body).toEqual({
      confirmName: 'Banking',
    });
    expect(screen.queryByRole('link', { name: /Banking/ })).not.toBeInTheDocument();
  });

  it('shows confirm_mismatch, and returns the focus to More after Esc', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/delete`,
      apiError(400, 'confirm_mismatch', 'The name does not match.'),
    );
    const { user } = renderApp(`/sessions/${SID}/live`);
    await user.click(await screen.findByRole('button', { name: 'More' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Type the session name to confirm'), 'Banking');
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await within(dialog).findByText('The name does not match.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });
});
