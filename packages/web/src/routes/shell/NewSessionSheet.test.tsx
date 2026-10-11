import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, SID } from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

async function openSheet() {
  const app = renderApp('/');
  await app.user.click(await screen.findByRole('button', { name: 'New session' }));
  const dialog = await screen.findByRole('dialog', { name: 'New session' });
  return { ...app, dialog };
}

describe('New session sheet', () => {
  it('creates a session and opens its Live view', async () => {
    mockLoggedIn(api);
    const created = makeSession({ state: 'starting' });
    api.on('POST /api/sessions', { status: 201, body: created });
    api.on(`GET /api/sessions/${SID}`, { body: created });
    const { user, dialog, router } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Banking');
    await user.type(form.getByLabelText('Allowlist'), 'example.com{Enter}.bank.example{Enter}');
    await user.type(form.getByLabelText('Timezone'), 'Europe/Rome');
    await user.click(form.getByRole('radio', { name: '1600 × 900' }));
    await user.click(form.getByRole('switch', { name: 'Start now' }));
    await user.click(form.getByRole('button', { name: 'Create' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Banking' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/sessions/${SID}/live`);
    expect(api.calls('POST /api/sessions')[0]?.body).toEqual({
      name: 'Banking',
      allowlist: ['example.com', '.bank.example'],
      timezone: 'Europe/Rome',
      screen: '1600x900',
      start: false,
    });
  });

  it('checks the fields before it sends the request', async () => {
    mockLoggedIn(api);
    const { user, dialog } = await openSheet();
    await user.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(within(dialog).getByLabelText('Name')).toHaveAccessibleDescription(
      'Use 1 to 64 characters.',
    );
    expect(within(dialog).getByLabelText('Allowlist')).toHaveAttribute('aria-invalid', 'true');
    expect(api.calls('POST /api/sessions')).toHaveLength(0);
  });

  it('rejects a pasted URL in the allowlist before it sends anything', async () => {
    mockLoggedIn(api);
    const { user, dialog } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Bank');
    await user.type(form.getByLabelText('Allowlist'), 'https://bank.example/login{Enter}');
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(form.getByLabelText('Allowlist')).toHaveAccessibleDescription(
      'Add 1 to 100 hosts, for example example.com or .example.com, or only *.',
    );
    expect(api.calls('POST /api/sessions')).toHaveLength(0);
  });

  it('shows the field errors and the other errors of the server', async () => {
    mockLoggedIn(api);
    api.on(
      'POST /api/sessions',
      apiError(400, 'validation_failed', 'Invalid input', { timezone: 'Unknown timezone' }),
      apiError(409, 'capacity_reached', '10 sessions are running. Stop one first.'),
    );
    const { user, dialog } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Shop');
    await user.type(form.getByLabelText('Allowlist'), 'shop.example{Enter}');
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(await form.findByText('Unknown timezone')).toBeInTheDocument();
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(await form.findByRole('alert')).toHaveTextContent('10 sessions are running');
  });

  it('shows a validation_failed answer in the banner when no field matches its keys', async () => {
    mockLoggedIn(api);
    api.on(
      'POST /api/sessions',
      apiError(400, 'validation_failed', 'Invalid input', { start: 'Required' }),
    );
    const { user, dialog } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Shop');
    await user.type(form.getByLabelText('Allowlist'), 'shop.example{Enter}');
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(await form.findByRole('alert')).toHaveTextContent('Invalid input');
  });

  it('shows a mapped field error at its field and no banner', async () => {
    mockLoggedIn(api);
    api.on(
      'POST /api/sessions',
      apiError(400, 'validation_failed', 'Invalid input', { name: 'Taken' }),
    );
    const { user, dialog } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Shop');
    await user.type(form.getByLabelText('Allowlist'), 'shop.example{Enter}');
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(await form.findByText('Taken')).toBeInTheDocument();
    expect(form.getByLabelText('Name')).toHaveAccessibleDescription('Taken');
    expect(form.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('clears the banner of an earlier attempt when the user submits again', async () => {
    mockLoggedIn(api);
    api.on('POST /api/sessions', apiError(409, 'capacity_reached', '10 sessions are running.'));
    const { user, dialog } = await openSheet();
    const form = within(dialog);
    await user.type(form.getByLabelText('Name'), 'Shop');
    await user.type(form.getByLabelText('Allowlist'), 'shop.example{Enter}');
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(await form.findByRole('alert')).toHaveTextContent('10 sessions are running');
    await user.clear(form.getByLabelText('Name'));
    await user.click(form.getByRole('button', { name: 'Create' }));
    expect(form.getByLabelText('Name')).toHaveAccessibleDescription('Use 1 to 64 characters.');
    expect(form.queryByRole('alert')).not.toBeInTheDocument();
    expect(api.calls('POST /api/sessions')).toHaveLength(1);
  });
});
