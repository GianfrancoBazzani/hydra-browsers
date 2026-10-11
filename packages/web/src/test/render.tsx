import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Me, SessionResource } from '@hydra/shared';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { createQueryClient } from '../app/query-client';
import { appRoutes } from '../routes';
import { makeMe } from './fixtures';
import type { MockApi } from './mock-api';

/** Renders the whole app at `path` with a fresh query client (no retries). */
export function renderApp(path: string) {
  const queryClient = createQueryClient({ retry: false });
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  const user = userEvent.setup();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, user, router, queryClient };
}

/** The routes that every logged-in screen loads: the user, the session list, the sessions. */
export function mockLoggedIn(
  api: MockApi,
  options: { me?: Me; sessions?: SessionResource[] } = {},
): void {
  const sessions = options.sessions ?? [];
  api.on('GET /api/auth/me', { body: options.me ?? makeMe() });
  api.on('GET /api/sessions', { body: sessions });
  for (const session of sessions) {
    api.on(`GET /api/sessions/${session.id}`, { body: session });
  }
}
