import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ANA_ID, BEN_ID, makeMember, makeSession, SID, VIEWER_RIGHTS } from '../../test/fixtures';
import { apiError, mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../../test/render';

let api: MockApi;

const MEMBERS = {
  owner: makeMember({
    userId: ANA_ID,
    email: 'ana@example.com',
    displayName: 'Ana',
    role: 'owner',
  }),
  members: [makeMember()],
};

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
  api.on(`GET /api/sessions/${SID}/members`, { body: MEMBERS });
});

describe('Sharing view', () => {
  it('adds a member by email, changes a role, and removes a member', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(`POST /api/sessions/${SID}/members`, {
      status: 201,
      body: makeMember({
        userId: 'u3',
        email: 'cleo@example.com',
        displayName: 'Cleo',
        role: 'operator',
      }),
    });
    api.on(`PATCH /api/sessions/${SID}/members/${BEN_ID}`, {
      body: makeMember({ role: 'operator' }),
    });
    api.on(`DELETE /api/sessions/${SID}/members/${BEN_ID}`, { status: 204 });
    const { user } = renderApp(`/sessions/${SID}/sharing`);
    const table = await screen.findByRole('table', { name: 'People with access' });
    expect(await within(table).findByText('Ben')).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: 'Owner' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'cleo@example.com');
    await user.click(screen.getByRole('radio', { name: 'Operator' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => {
      expect(api.calls(`POST /api/sessions/${SID}/members`)[0]?.body).toEqual({
        email: 'cleo@example.com',
        role: 'operator',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Role of Ben: Viewer' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Operator' }));
    await waitFor(() => {
      expect(api.calls(`PATCH /api/sessions/${SID}/members/${BEN_ID}`)[0]?.body).toEqual({
        role: 'operator',
      });
    });

    await user.click(screen.getByRole('button', { name: 'Remove Ben' }));
    await waitFor(() => {
      expect(api.calls(`DELETE /api/sessions/${SID}/members/${BEN_ID}`)).toHaveLength(1);
    });
  });

  it('is read-only without session.share', async () => {
    mockLoggedIn(api, { sessions: [makeSession({ myRole: 'viewer', rights: VIEWER_RIGHTS })] });
    renderApp(`/sessions/${SID}/sharing`);
    const table = await screen.findByRole('table', { name: 'People with access' });
    expect(await within(table).findByRole('cell', { name: 'Viewer' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove Ben' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Role of Ben/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Email')).not.toBeInTheDocument();
  });

  it('shows the error of a failed add', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/members`,
      apiError(409, 'conflict', 'This user is already a member.'),
    );
    const { user } = renderApp(`/sessions/${SID}/sharing`);
    await user.type(await screen.findByLabelText('Email'), 'ben@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('This user is already a member.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows a conflict of the add in an alert, not at the email field', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/members`,
      apiError(409, 'conflict', 'This user is already a member.'),
    );
    const { user } = renderApp(`/sessions/${SID}/sharing`);
    await user.type(await screen.findByLabelText('Email'), 'ben@example.com');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This user is already a member.');
  });

  it('shows a validation error of the email at the field, without an alert', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `POST /api/sessions/${SID}/members`,
      apiError(400, 'validation_failed', 'The request is invalid.', {
        email: 'Enter a valid email address.',
      }),
    );
    const { user } = renderApp(`/sessions/${SID}/sharing`);
    await user.type(await screen.findByLabelText('Email'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the errors of a failed role change and a failed removal', async () => {
    mockLoggedIn(api, { sessions: [makeSession()] });
    api.on(
      `PATCH /api/sessions/${SID}/members/${BEN_ID}`,
      apiError(404, 'not_found', 'This member was not found.'),
    );
    api.on(
      `DELETE /api/sessions/${SID}/members/${BEN_ID}`,
      apiError(404, 'not_found', 'This member was already removed.'),
    );
    const { user } = renderApp(`/sessions/${SID}/sharing`);
    await user.click(await screen.findByRole('button', { name: 'Role of Ben: Viewer' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Operator' }));
    expect(await screen.findByText('This member was not found.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove Ben' }));
    expect(await screen.findByText('This member was already removed.')).toBeInTheDocument();
    expect(screen.getByText('This member was not found.')).toBeInTheDocument();
  });
});
