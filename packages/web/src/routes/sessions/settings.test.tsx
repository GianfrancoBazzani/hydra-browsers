import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeSession, OPERATOR_RIGHTS, SID, VIEWER_RIGHTS } from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
  api.on(`GET /api/sessions/${SID}/logs`, (request) => ({
    body: {
      container: request.query.get('container'),
      lines: [`${request.query.get('container') ?? ''} line 1`, 'line 2'],
    },
  }));
});

describe('Settings view', () => {
  it('saves only the changed fields and shows Restart required', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`PATCH /api/sessions/${SID}`, {
      body: makeSession({
        restartRequired: true,
        settings: { ...makeSession().settings, allowlist: ['example.com', 'bank.example'] },
      }),
    });
    const { user } = renderApp(`/sessions/${SID}/settings`);
    const allowlist = await screen.findByLabelText('Allowlist');
    expect(screen.getByLabelText('Name')).toHaveValue('Banking');
    expect(screen.getByLabelText('Timezone')).toHaveValue('Europe/Rome');
    expect(screen.getByRole('radio', { name: '1920 × 1080' })).toBeChecked();
    await user.type(allowlist, 'bank.example{Enter}');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(/Restart required/)).toBeInTheDocument();
    expect(screen.getByText('Saved')).toBeInTheDocument();
    expect(api.calls(`PATCH /api/sessions/${SID}`)[0]?.body).toEqual({
      allowlist: ['example.com', 'bank.example'],
    });
  });

  it('shows the diagnostics of both containers', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    const { user } = renderApp(`/sessions/${SID}/settings`);
    expect(await screen.findByText(/neko line 1/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'mcp' }));
    expect(await screen.findByText(/mcp line 1/)).toBeInTheDocument();
    expect(api.calls(`GET /api/sessions/${SID}/logs`).map((r) => r.query.get('container'))).toEqual(
      ['neko', 'mcp'],
    );
  });

  it('shows a field error of the server', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `PATCH /api/sessions/${SID}`,
      apiError(400, 'validation_failed', 'Invalid input', { language: 'Unknown language tag' }),
    );
    const { user } = renderApp(`/sessions/${SID}/settings`);
    const language = await screen.findByLabelText('Language');
    await user.clear(language);
    await user.type(language, 'xx-YY');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Unknown language tag')).toBeInTheDocument();
    expect(language).toHaveAttribute('aria-invalid', 'true');
  });

  it('is read-only for a viewer and hides Diagnostics without session.logs', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    renderApp(`/sessions/${SID}/settings`);
    expect(await screen.findByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Diagnostics' })).not.toBeInTheDocument();
    await waitFor(() => {
      expect(api.calls(`GET /api/sessions/${SID}/logs`)).toHaveLength(0);
    });
  });

  it('shows Diagnostics to an operator, who cannot change the settings', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'operator', rights: OPERATOR_RIGHTS })] });
    renderApp(`/sessions/${SID}/settings`);
    const diagnostics = await screen.findByRole('region', { name: 'Diagnostics' });
    expect(await within(diagnostics).findByText(/neko line 1/)).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeDisabled();
  });

  it('shows a save error that maps to no field in a banner', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `PATCH /api/sessions/${SID}`,
      apiError(400, 'validation_failed', 'Invalid input', { unknownField: 'Unknown field' }),
    );
    const { user } = renderApp(`/sessions/${SID}/settings`);
    await user.type(await screen.findByLabelText('Name'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid input');
  });

  it('shows an error banner when the log fetch fails', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `GET /api/sessions/${SID}/logs`,
      apiError(500, 'internal', 'Logs cannot be read right now.'),
    );
    renderApp(`/sessions/${SID}/settings`);
    expect(await screen.findByRole('alert')).toHaveTextContent('Logs cannot be read right now.');
  });
});
