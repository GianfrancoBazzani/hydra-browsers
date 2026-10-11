import { screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeMe, makeSession, SID, SID_2 } from '../../test/fixtures';
import { mockApi, type MockApi } from '../../test/mock-api';
import { MockEventSource } from '../../test/mock-event-source';
import { renderApp } from '../../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

describe('Admin → All sessions', () => {
  it('lists all sessions with their owner and state', async () => {
    api.on('GET /api/auth/me', { body: makeMe({ role: 'admin' }) });
    api.on('GET /api/sessions', (request) => ({
      body:
        request.query.get('all') === '1'
          ? [
              makeSession(),
              makeSession({
                id: SID_2,
                name: 'Shop',
                state: 'stopped',
                myRole: 'admin',
                owner: { id: 'u9', email: 'cleo@example.com', displayName: 'Cleo' },
              }),
            ]
          : [makeSession()],
    }));
    renderApp('/admin/sessions');
    const table = await screen.findByRole('table', { name: 'All sessions' });
    const shop = await within(table).findByRole('link', { name: 'Shop' });
    expect(shop).toHaveAttribute('href', `/sessions/${SID_2}`);
    expect(within(table).getByText('cleo@example.com')).toBeInTheDocument();
    expect(within(table).getByText('Stopped')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Banking' })).toHaveAttribute(
      'href',
      `/sessions/${SID}`,
    );
  });

  it('shows the error of a failed load', async () => {
    api.on('GET /api/auth/me', { body: makeMe({ role: 'admin' }) });
    api.on('GET /api/sessions', (request) =>
      request.query.get('all') === '1'
        ? { status: 503, body: 'Service Unavailable' }
        : { body: [] },
    );
    renderApp('/admin/sessions');
    expect(await screen.findByRole('alert')).toHaveTextContent('The request failed with HTTP 503.');
  });

  it('is not found for members', async () => {
    api.on('GET /api/auth/me', { body: makeMe() });
    api.on('GET /api/sessions', { body: [] });
    renderApp('/admin/sessions');
    expect(await screen.findByRole('heading', { level: 1, name: 'Not found' })).toBeInTheDocument();
    expect(api.requests.some((r) => r.query.get('all') === '1')).toBe(false);
  });
});
