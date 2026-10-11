import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { makeMe } from '../test/fixtures';
import { apiError, mockApi, type MockApi } from '../test/mock-api';
import { MockEventSource } from '../test/mock-event-source';
import { mockLoggedIn, renderApp } from '../test/render';

let api: MockApi;

beforeEach(() => {
  api = mockApi();
  MockEventSource.install();
});

describe('Login', () => {
  it('sends a user without a login session to Login, and back after the login', async () => {
    api.on('GET /api/auth/me', apiError(401, 'unauthenticated', 'Log in'));
    api.on('POST /api/auth/login', { body: makeMe() });
    api.on('GET /api/sessions', { body: [] });
    const { user, router } = renderApp('/some/page?tab=2');
    expect(await screen.findByRole('button', { name: 'Log in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    await user.type(screen.getByLabelText('Email'), ' ana@example.com ');
    await user.type(screen.getByLabelText('Password'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/some/page');
    expect(router.state.location.search).toBe('?tab=2');
    expect(api.calls('POST /api/auth/login')[0]?.body).toEqual({
      email: 'ana@example.com',
      password: 'correct horse battery',
    });
  });

  it('shows the spec text for a failed login', async () => {
    api.on('GET /api/auth/me', apiError(401, 'unauthenticated', 'Log in'));
    api.on(
      'POST /api/auth/login',
      apiError(401, 'invalid_credentials', 'Invalid email or password'),
    );
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('shows the server message when the login is rate limited', async () => {
    api.on('GET /api/auth/me', apiError(401, 'unauthenticated', 'Log in'));
    api.on(
      'POST /api/auth/login',
      apiError(429, 'rate_limited', 'Too many attempts. Wait 15 minutes.'),
    );
    const { user } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Wait 15 minutes.',
    );
  });

  it('opens Change password after a login with a one-time password', async () => {
    api.on('GET /api/auth/me', apiError(401, 'unauthenticated', 'Log in'));
    api.on('POST /api/auth/login', { body: makeMe({ mustChangePassword: true }) });
    const { user, router } = renderApp('/login');
    await user.type(await screen.findByLabelText('Email'), 'ana@example.com');
    await user.type(screen.getByLabelText('Password'), 'one-time-password');
    await user.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('heading', { name: 'Change password' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/change-password');
  });

  it('shows an error with Try again when the server cannot be reached at load', async () => {
    api.on(
      'GET /api/auth/me',
      () => {
        throw new TypeError('Failed to fetch');
      },
      { body: makeMe() },
    );
    api.on('GET /api/sessions', { body: [] });
    const { user } = renderApp('/');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server cannot be reached. Check your connection.',
    );
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
  });

  it('sends a logged-in user from Login to the start page', async () => {
    mockLoggedIn(api);
    const { router } = renderApp('/login');
    expect(await screen.findByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});
