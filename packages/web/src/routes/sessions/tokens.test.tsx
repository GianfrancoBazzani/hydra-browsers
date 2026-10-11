import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BEN_ID,
  makeSession,
  makeToken,
  OPERATOR_RIGHTS,
  SID,
  VIEWER_RIGHTS,
} from '../../test/fixtures';
import { apiError, mockApi, type MockApi, type MockResponse } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

const MINE = makeToken();
const BENS = makeToken({
  id: '01J9ZC0000000000000000TKN2',
  name: 'ci',
  createdBy: { id: BEN_ID, displayName: 'Ben' },
});

describe('Tokens view', () => {
  it('creates a token and shows it one time with the claude command and the JSON config', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/tokens`, { body: [MINE] });
    api.on(`POST /api/sessions/${SID}/tokens`, {
      status: 201,
      body: {
        token: makeToken({ id: '01J9ZC0000000000000000TKN3', name: 'agent' }),
        secret: 'hyd_SECRET',
      },
    });
    const { user } = renderApp(`/sessions/${SID}/tokens`);
    const table = await screen.findByRole('table', { name: 'Agent tokens' });
    expect(await within(table).findByRole('cell', { name: 'laptop' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'hyd_AbCdEfGh…' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'New token' }));
    const sheet = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(sheet).getByLabelText('Name'), 'agent');
    await user.click(within(sheet).getByRole('radio', { name: '7 days' }));
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));

    const created = await screen.findByRole('dialog', { name: 'Token “agent” created' });
    expect(created).toHaveClass('w-140');
    const endpoint = `${window.location.origin}/s/${SID}/mcp`;
    expect(within(created).getByRole('figure', { name: 'Claude Code command' })).toHaveTextContent(
      `claude mcp add --transport http agent ${endpoint} --header "Authorization: Bearer hyd_SECRET"`,
    );
    const json = within(created).getByRole('figure', { name: 'mcpServers config' }).textContent;
    expect(JSON.parse(json)).toEqual({
      mcpServers: {
        agent: {
          type: 'http',
          url: endpoint,
          headers: { Authorization: 'Bearer hyd_SECRET' },
        },
      },
    });
    expect(api.calls(`POST /api/sessions/${SID}/tokens`)[0]?.body).toEqual({
      name: 'agent',
      expiresInDays: 7,
    });
    await user.click(within(created).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByText(/hyd_SECRET/)).not.toBeInTheDocument();
    });
  });

  it('shows the new token secret before the slow token list refetch ends', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    let finishList: (response: MockResponse) => void = () => undefined;
    api.on(
      `GET /api/sessions/${SID}/tokens`,
      { body: [MINE] },
      () =>
        new Promise<MockResponse>((resolve) => {
          finishList = resolve;
        }),
    );
    api.on(`POST /api/sessions/${SID}/tokens`, {
      status: 201,
      body: {
        token: makeToken({ id: '01J9ZC0000000000000000TKN3', name: 'agent' }),
        secret: 'hyd_SLOW',
      },
    });
    const { user } = renderApp(`/sessions/${SID}/tokens`);
    await screen.findByRole('table', { name: 'Agent tokens' });
    await user.click(screen.getByRole('button', { name: 'New token' }));
    const sheet = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(sheet).getByLabelText('Name'), 'agent');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    // The list refetch is held open: the secret must show anyway.
    const created = await screen.findByRole('dialog', { name: 'Token “agent” created' });
    expect(within(created).getByRole('figure', { name: 'Claude Code command' })).toHaveTextContent(
      'hyd_SLOW',
    );
    expect(api.calls(`GET /api/sessions/${SID}/tokens`)).toHaveLength(2);
    finishList({ body: [MINE] });
  });

  it('lets an operator revoke only own tokens', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'operator', rights: OPERATOR_RIGHTS })] });
    api.on(`GET /api/sessions/${SID}/tokens`, { body: [MINE, BENS] });
    api.on(`DELETE /api/sessions/${SID}/tokens/${MINE.id}`, { status: 204 });
    const { user } = renderApp(`/sessions/${SID}/tokens`);
    const revoke = await screen.findByRole('button', { name: 'Revoke laptop' });
    expect(screen.queryByRole('button', { name: 'Revoke ci' })).not.toBeInTheDocument();
    await user.click(revoke);
    await waitFor(() => {
      expect(api.calls(`DELETE /api/sessions/${SID}/tokens/${MINE.id}`)).toHaveLength(1);
    });
    expect(api.calls(`DELETE /api/sessions/${SID}/tokens/${MINE.id}`)[0]?.body).toEqual({});
  });

  it('lets the owner revoke any token and marks revoked tokens', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/tokens`, {
      body: [BENS, makeToken({ id: '01J9ZC0000000000000000TKN4', name: 'old', revokedAt: 1 })],
    });
    renderApp(`/sessions/${SID}/tokens`);
    expect(await screen.findByRole('button', { name: 'Revoke ci' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Revoked' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke old' })).not.toBeInTheDocument();
  });

  it('is not open to a viewer, who goes to the Live view', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    api.on(`POST /api/sessions/${SID}/live-ticket`, {
      body: { url: `http://live.hydra.localhost/s/${SID}/?ticket=t1` },
    });
    const { router } = renderApp(`/sessions/${SID}/tokens`);
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    });
    expect(screen.queryByRole('radio', { name: 'Tokens' })).not.toBeInTheDocument();
    expect(api.calls(`GET /api/sessions/${SID}/tokens`)).toHaveLength(0);
  });

  it('shows the error of a failed create', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/tokens`, { body: [] });
    api.on(
      `POST /api/sessions/${SID}/tokens`,
      apiError(403, 'forbidden', 'You cannot create tokens.'),
    );
    const { user } = renderApp(`/sessions/${SID}/tokens`);
    expect(await screen.findByRole('cell', { name: 'No tokens' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New token' }));
    const sheet = await screen.findByRole('dialog', { name: 'New token' });
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    const name = within(sheet).getByLabelText('Name');
    expect(name).toHaveAccessibleDescription('Use 1 to 64 letters, digits, "-", or "_".');
    await user.type(name, 'my laptop');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(name).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls(`POST /api/sessions/${SID}/tokens`)).toHaveLength(0);
    await user.clear(name);
    await user.type(name, 'x');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('You cannot create tokens.');
  });

  it('keeps the New token sheet open while the create request is pending', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/tokens`, { body: [] });
    let finish: (response: MockResponse) => void = () => undefined;
    api.on(
      `POST /api/sessions/${SID}/tokens`,
      () =>
        new Promise<MockResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderApp(`/sessions/${SID}/tokens`);
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const sheet = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(sheet).getByLabelText('Name'), 'agent');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(api.calls(`POST /api/sessions/${SID}/tokens`)).toHaveLength(1);
    });

    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'New token' })).toBeInTheDocument();

    finish({
      status: 201,
      body: { token: makeToken({ name: 'agent' }), secret: 'hyd_PENDING' },
    });
    expect(
      await screen.findByRole('dialog', { name: 'Token “agent” created' }),
    ).toBeInTheDocument();
  });

  it('does not keep the token secret in the mutation cache after Done', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/tokens`, { body: [] });
    api.on(`POST /api/sessions/${SID}/tokens`, {
      status: 201,
      body: { token: makeToken({ name: 'agent' }), secret: 'hyd_GCTEST' },
    });
    const { user, queryClient } = renderApp(`/sessions/${SID}/tokens`);
    await user.click(await screen.findByRole('button', { name: 'New token' }));
    const sheet = await screen.findByRole('dialog', { name: 'New token' });
    await user.type(within(sheet).getByLabelText('Name'), 'agent');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    const created = await screen.findByRole('dialog', { name: 'Token “agent” created' });
    expect(within(created).getByRole('figure', { name: 'mcpServers config' })).toHaveTextContent(
      'hyd_GCTEST',
    );
    await user.click(within(created).getByRole('button', { name: 'Done' }));

    await waitFor(() => {
      const holders = queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => JSON.stringify(mutation.state.data ?? null).includes('hyd_GCTEST'));
      expect(holders).toHaveLength(0);
    });
  });
});
