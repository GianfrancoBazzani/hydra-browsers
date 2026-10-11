import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ANA_ID, BEN_ID, makeMe, makeUser } from '../../test/fixtures';
import { apiError, mockApi, type MockApi, type MockResponse } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

const ADMIN = makeMe({ role: 'admin' });

describe('Admin → Users', () => {
  it('creates a user and shows the one-time password one time', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser()] });
    api.on('POST /api/users', {
      status: 201,
      body: {
        user: makeUser({ id: 'u3', email: 'cleo@example.com', displayName: 'Cleo', role: 'admin' }),
        oneTimePassword: 'otp-123456789',
      },
    });
    const { user } = renderApp('/admin/users');
    const table = await screen.findByRole('table', { name: 'Users' });
    expect(await within(table).findByRole('cell', { name: 'ben@example.com' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Active' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'cleo@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('checkbox', { name: 'Administrator' }));
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));

    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-123456789',
    );
    expect(shown).toHaveAccessibleDescription(/cleo@example\.com/);
    expect(api.calls('POST /api/users')[0]?.body).toEqual({
      email: 'cleo@example.com',
      displayName: 'Cleo',
      role: 'admin',
    });
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByText('otp-123456789')).not.toBeInTheDocument();
    });
  });

  it('disables, resets, changes the role of, and unlocks a user', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser({ locked: true })] });
    api.on(`PATCH /api/users/${BEN_ID}`, { body: makeUser() });
    api.on(`POST /api/users/${BEN_ID}/reset-password`, {
      body: { oneTimePassword: 'otp-reset-1' },
    });
    api.on(`POST /api/users/${BEN_ID}/unlock`, { body: makeUser() });
    const { user } = renderApp('/admin/users');
    expect(await screen.findByRole('cell', { name: 'Locked' })).toBeInTheDocument();

    const actions = () => screen.getByRole('button', { name: 'Actions for ben@example.com' });
    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Make admin' }));
    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Unlock' }));
    await waitFor(() => {
      expect(api.calls(`PATCH /api/users/${BEN_ID}`).map((r) => r.body)).toEqual([
        { status: 'disabled' },
        { role: 'admin' },
      ]);
    });
    expect(api.calls(`POST /api/users/${BEN_ID}/unlock`)[0]?.body).toEqual({});

    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-reset-1',
    );
  });

  it('changes the name of a user', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser()] });
    api.on(`PATCH /api/users/${BEN_ID}`, { body: makeUser({ displayName: 'Benjamin' }) });
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Actions for ben@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change name' }));
    const sheet = await screen.findByRole('dialog', { name: 'Change name' });
    const name = within(sheet).getByLabelText('Name');
    expect(name).toHaveValue('Ben');
    await user.clear(name);
    await user.type(name, 'Benjamin');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(api.calls(`PATCH /api/users/${BEN_ID}`)[0]?.body).toEqual({ displayName: 'Benjamin' });
  });

  it('shows the error of a failed create', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [] });
    api.on('POST /api/users', apiError(409, 'conflict', 'The email exists.'));
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'ben@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Ben');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The email exists.');
  });

  it('does not keep a created one-time password in the mutation cache after Done', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [] });
    api.on('POST /api/users', {
      status: 201,
      body: {
        user: makeUser({ id: 'u3', email: 'cleo@example.com' }),
        oneTimePassword: 'otp-GCTEST-1',
      },
    });
    const { user, queryClient } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'cleo@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-GCTEST-1',
    );
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      const holders = queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => JSON.stringify(mutation.state.data ?? null).includes('otp-GCTEST-1'));
      expect(holders).toHaveLength(0);
    });
  });

  it('does not keep a reset one-time password in the mutation cache after Done', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser()] });
    api.on(`POST /api/users/${BEN_ID}/reset-password`, {
      body: { oneTimePassword: 'otp-GCTEST-2' },
    });
    const { user, queryClient } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Actions for ben@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(shown).toHaveAccessibleDescription(/ben@example\.com/);
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-GCTEST-2',
    );
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      const holders = queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => JSON.stringify(mutation.state.data ?? null).includes('otp-GCTEST-2'));
      expect(holders).toHaveLength(0);
    });
    await waitFor(() => {
      expect(screen.queryByText('otp-GCTEST-2')).not.toBeInTheDocument();
    });
  });

  it('shows a one-time password before the slow user list refetch ends', async () => {
    mockLoggedIn(api, { me: ADMIN });
    let finishList: (response: MockResponse) => void = () => undefined;
    api.on(
      'GET /api/users',
      { body: [makeUser()] },
      () =>
        new Promise<MockResponse>((resolve) => {
          finishList = resolve;
        }),
    );
    api.on('POST /api/users', {
      status: 201,
      body: {
        user: makeUser({ id: 'u3', email: 'cleo@example.com' }),
        oneTimePassword: 'otp-SLOW-1',
      },
    });
    api.on(`POST /api/users/${BEN_ID}/reset-password`, { body: { oneTimePassword: 'otp-SLOW-2' } });
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'cleo@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    // The list refetch is held open: the password must show anyway.
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-SLOW-1',
    );
    expect(api.calls('GET /api/users')).toHaveLength(2);
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    finishList({ body: [makeUser()] });

    // The same holds for a reset (the list refetch is not held open this time).
    await user.click(await screen.findByRole('button', { name: 'Actions for ben@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    const reset = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(reset).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-SLOW-2',
    );
  });

  it('keeps the Create user sheet open while the create request is pending', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [] });
    let finish: (response: MockResponse) => void = () => undefined;
    api.on(
      'POST /api/users',
      () =>
        new Promise<MockResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'cleo@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    await waitFor(() => {
      expect(api.calls('POST /api/users')).toHaveLength(1);
    });

    expect(within(sheet).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Create user' })).toBeInTheDocument();

    finish({
      status: 201,
      body: {
        user: makeUser({ id: 'u3', email: 'cleo@example.com', displayName: 'Cleo' }),
        oneTimePassword: 'otp-PENDING',
      },
    });
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    expect(within(shown).getByRole('figure', { name: 'One-time password' })).toHaveTextContent(
      'otp-PENDING',
    );
  });

  it('shows a validation error of a field under that field', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [] });
    api.on(
      'POST /api/users',
      apiError(400, 'validation_failed', 'The request is not valid.', {
        email: 'Enter a valid email address.',
      }),
    );
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Create user' }));
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'not-an-email');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    expect(await within(sheet).findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(within(sheet).getByLabelText('Email')).toHaveAccessibleDescription(
      'Enter a valid email address.',
    );
    expect(within(sheet).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the error of a failed rename and keeps the sheet open', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser()] });
    api.on(`PATCH /api/users/${BEN_ID}`, apiError(500, 'internal', 'The server failed.'));
    const { user } = renderApp('/admin/users');
    await user.click(await screen.findByRole('button', { name: 'Actions for ben@example.com' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Change name' }));
    const sheet = await screen.findByRole('dialog', { name: 'Change name' });
    await user.type(within(sheet).getByLabelText('Name'), 'x');
    await user.click(within(sheet).getByRole('button', { name: 'Save' }));
    expect(await within(sheet).findByRole('alert')).toHaveTextContent('The server failed.');
    expect(screen.getByRole('dialog', { name: 'Change name' })).toBeInTheDocument();
  });

  it('shows the error of a failed row action', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser({ locked: true })] });
    api.on(`PATCH /api/users/${BEN_ID}`, apiError(409, 'conflict', 'The last admin stays.'));
    api.on(`POST /api/users/${BEN_ID}/reset-password`, apiError(500, 'internal', 'Reset failed.'));
    api.on(`POST /api/users/${BEN_ID}/unlock`, apiError(500, 'internal', 'Unlock failed.'));
    const { user } = renderApp('/admin/users');
    await screen.findByRole('cell', { name: 'Locked' });
    const actions = () => screen.getByRole('button', { name: 'Actions for ben@example.com' });

    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The last admin stays.');

    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Reset failed.');
    });
    expect(screen.queryByRole('dialog', { name: 'One-time password' })).not.toBeInTheDocument();

    await user.click(actions());
    await user.click(await screen.findByRole('menuitem', { name: 'Unlock' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('Unlock failed.');
    });
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('shows Enable for a disabled user and no Unlock for an unlocked one', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser({ status: 'disabled', role: 'admin' })] });
    api.on(`PATCH /api/users/${BEN_ID}`, { body: makeUser() });
    const { user } = renderApp('/admin/users');
    expect(await screen.findByRole('cell', { name: 'Disabled' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for ben@example.com' }));
    expect(await screen.findByRole('menuitem', { name: 'Make member' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Unlock' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Enable' }));
    await waitFor(() => {
      expect(api.calls(`PATCH /api/users/${BEN_ID}`)[0]?.body).toEqual({ status: 'active' });
    });
  });

  it('returns the focus to the row button after a sheet of its menu closes', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser()] });
    api.on(`POST /api/users/${BEN_ID}/reset-password`, {
      body: { oneTimePassword: 'otp-focus-1' },
    });
    const { user } = renderApp('/admin/users');
    const actions = await screen.findByRole('button', { name: 'Actions for ben@example.com' });

    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Change name' }));
    const rename = await screen.findByRole('dialog', { name: 'Change name' });
    await user.click(within(rename).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(actions).toHaveFocus();

    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Reset password' }));
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(actions).toHaveFocus();
  });

  it('returns the focus to Create user after the one-time password sheet closes', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [] });
    api.on('POST /api/users', {
      status: 201,
      body: { user: makeUser({ id: 'u3', email: 'cleo@example.com' }), oneTimePassword: 'otp-f2' },
    });
    const { user } = renderApp('/admin/users');
    const create = await screen.findByRole('button', { name: 'Create user' });
    await user.click(create);
    const sheet = await screen.findByRole('dialog', { name: 'Create user' });
    await user.type(within(sheet).getByLabelText('Email'), 'cleo@example.com');
    await user.type(within(sheet).getByLabelText('Name'), 'Cleo');
    await user.click(within(sheet).getByRole('button', { name: 'Create' }));
    const shown = await screen.findByRole('dialog', { name: 'One-time password' });
    await user.click(within(shown).getByRole('button', { name: 'Done' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(create).toHaveFocus();
  });

  it('disables the update and unlock items while an update or unlock request is pending', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', { body: [makeUser({ locked: true })] });
    let finish: (response: MockResponse) => void = () => undefined;
    api.on(
      `PATCH /api/users/${BEN_ID}`,
      () =>
        new Promise<MockResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const { user } = renderApp('/admin/users');
    const actions = await screen.findByRole('button', { name: 'Actions for ben@example.com' });
    await user.click(actions);
    await user.click(await screen.findByRole('menuitem', { name: 'Disable' }));
    await waitFor(() => {
      expect(api.calls(`PATCH /api/users/${BEN_ID}`)).toHaveLength(1);
    });

    await user.click(actions);
    for (const name of ['Make admin', 'Unlock', 'Disable']) {
      expect(await screen.findByRole('menuitem', { name })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(screen.getByRole('menuitem', { name: 'Change name' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await user.keyboard('{Escape}');

    finish({ body: makeUser() });
    await waitFor(() => {
      expect(api.calls('GET /api/users').length).toBeGreaterThan(1);
    });
    await user.click(actions);
    expect(await screen.findByRole('menuitem', { name: 'Make admin' })).not.toHaveAttribute(
      'aria-disabled',
    );
    expect(screen.getByRole('menuitem', { name: 'Unlock' })).not.toHaveAttribute('aria-disabled');
  });

  it('does not allow the own role, status, or password reset, but other rows', async () => {
    mockLoggedIn(api, { me: ADMIN });
    api.on('GET /api/users', {
      body: [makeUser({ id: ANA_ID, email: 'ana@example.com', role: 'admin' }), makeUser()],
    });
    const { user } = renderApp('/admin/users');
    const items = ['Make member', 'Disable', 'Reset password'];

    await user.click(await screen.findByRole('button', { name: 'Actions for ana@example.com' }));
    for (const name of items) {
      expect(await screen.findByRole('menuitem', { name })).toHaveAttribute(
        'aria-disabled',
        'true',
      );
    }
    expect(screen.getByRole('menuitem', { name: 'Change name' })).not.toHaveAttribute(
      'aria-disabled',
    );
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Actions for ben@example.com' }));
    expect(await screen.findByRole('menuitem', { name: 'Make admin' })).not.toHaveAttribute(
      'aria-disabled',
    );
    for (const name of ['Disable', 'Reset password']) {
      expect(screen.getByRole('menuitem', { name })).not.toHaveAttribute('aria-disabled');
    }
  });

  it('is not found for members', async () => {
    mockLoggedIn(api);
    renderApp('/admin/users');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(api.calls('GET /api/users')).toHaveLength(0);
  });
});
