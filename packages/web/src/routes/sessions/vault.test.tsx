import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeCredential, makeSession, SID, VIEWER_RIGHTS } from '../../test/fixtures';
import { mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;
const CRED = makeCredential();

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

describe('Vault view', () => {
  it('lists credentials and reveals a password for the owner', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/vault`, { body: [CRED] });
    api.on(`POST /api/sessions/${SID}/vault/${CRED.id}/reveal`, {
      body: { field: 'password', value: 'hunter2-secret' },
    });
    const { user } = renderApp(`/sessions/${SID}/vault`);
    const table = await screen.findByRole('table', { name: 'Credentials' });
    expect(
      await within(table).findByRole('cell', { name: 'catalina@example.com' }),
    ).toBeInTheDocument();
    await user.click(within(table).getByRole('button', { name: 'Google - Catalina' }));
    const sheet = await screen.findByRole('dialog', { name: 'Google - Catalina' });
    expect(within(sheet).queryByText('hunter2-secret')).toBeNull();
    await user.click(within(sheet).getByRole('button', { name: 'Show password' }));
    expect(await within(sheet).findByText('hunter2-secret')).toBeInTheDocument();
    expect(api.calls(`POST /api/sessions/${SID}/vault/${CRED.id}/reveal`)[0]?.body).toEqual({
      field: 'password',
    });
    await user.click(within(sheet).getByRole('button', { name: 'Hide password' }));
    expect(within(sheet).queryByText('hunter2-secret')).toBeNull();
  });

  it('shows the current code with the countdown ring', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/vault`, { body: [CRED] });
    api.on(`POST /api/sessions/${SID}/vault/${CRED.id}/reveal`, {
      body: { field: 'totp', code: '081804', validUntil: Date.now() + 12_000, period: 30 },
    });
    const { user } = renderApp(`/sessions/${SID}/vault`);
    await user.click(await screen.findByRole('button', { name: 'Google - Catalina' }));
    const sheet = await screen.findByRole('dialog', { name: 'Google - Catalina' });
    await user.click(within(sheet).getByRole('button', { name: 'Show code' }));
    expect(await within(sheet).findByText('081804')).toBeInTheDocument();
    expect(within(sheet).getByRole('img', { name: /seconds left/ })).toBeInTheDocument();
  });

  it('gives a viewer no create button and no reveal buttons', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    api.on(`GET /api/sessions/${SID}/vault`, { body: [CRED] });
    const { user } = renderApp(`/sessions/${SID}/vault`);
    await user.click(await screen.findByRole('button', { name: 'Google - Catalina' }));
    const sheet = await screen.findByRole('dialog', { name: 'Google - Catalina' });
    expect(screen.queryByRole('button', { name: 'New credential' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Show password' })).toBeNull();
    expect(within(sheet).queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('creates a credential with an otpauth URI', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/vault`, { body: [] });
    api.on(`POST /api/sessions/${SID}/vault`, { status: 201, body: CRED });
    const { user } = renderApp(`/sessions/${SID}/vault`);
    await user.click(await screen.findByRole('button', { name: 'New credential' }));
    const sheet = await screen.findByRole('dialog', { name: 'New credential' });
    await user.type(within(sheet).getByLabelText('Name'), 'Google - Catalina');
    await user.type(within(sheet).getByLabelText('Website'), 'www.google.com');
    await user.type(within(sheet).getByLabelText('Login'), 'catalina@example.com');
    await user.type(within(sheet).getByLabelText('Password'), 'hunter2-secret');
    await user.type(
      within(sheet).getByLabelText('Two-factor secret'),
      'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8',
    );
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(api.calls(`POST /api/sessions/${SID}/vault`)[0]?.body).toEqual({
        name: 'Google - Catalina',
        website: 'www.google.com',
        username: 'catalina@example.com',
        password: 'hunter2-secret',
        totp: { uri: 'otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8' },
      });
    });
  });

  it('removes the password in the edit sheet', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`GET /api/sessions/${SID}/vault`, { body: [CRED] });
    api.on(`PATCH /api/sessions/${SID}/vault/${CRED.id}`, {
      body: { ...CRED, hasPassword: false },
    });
    const { user } = renderApp(`/sessions/${SID}/vault`);
    await user.click(await screen.findByRole('button', { name: 'Google - Catalina' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Google - Catalina' })).getByRole('button', {
        name: 'Edit',
      }),
    );
    const edit = await screen.findByRole('dialog', { name: 'Edit credential' });
    await user.click(within(edit).getByRole('button', { name: 'Remove password' }));
    await user.click(within(edit).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(api.calls(`PATCH /api/sessions/${SID}/vault/${CRED.id}`)[0]?.body).toEqual({
        password: null,
      });
    });
  });
});
