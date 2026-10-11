import type { RouteObject } from 'react-router';
import { AdminSessionsPage } from './admin/sessions';
import { AdminUsersPage } from './admin/users';
import { ChangePasswordPage } from './change-password';
import { RequireAdmin, RequireLogin } from './guards';
import { LoginPage } from './login';
import { ActivityView } from './sessions/activity';
import { SessionIndex, SessionLayout } from './sessions/layout';
import { LiveView } from './sessions/live';
import { SettingsView } from './sessions/settings';
import { SharingView } from './sessions/sharing';
import { TokensView } from './sessions/tokens';
import { AppShell } from './shell/AppShell';
import { HomePage } from './shell/HomePage';
import { NotFoundPage } from './shell/NotFoundPage';

/** All routes (spec section 3.2). main.tsx and the tests build their routers from it. */
export const appRoutes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/change-password',
    element: (
      <RequireLogin allowPasswordChange>
        <ChangePasswordPage />
      </RequireLogin>
    ),
  },
  {
    path: '/',
    element: (
      <RequireLogin>
        <AppShell />
      </RequireLogin>
    ),
    children: [
      { index: true, element: <HomePage /> },
      {
        path: 'sessions/:sid',
        element: <SessionLayout />,
        children: [
          { index: true, element: <SessionIndex /> },
          { path: 'live', element: <LiveView /> },
          { path: 'tokens', element: <TokensView /> },
          { path: 'sharing', element: <SharingView /> },
          { path: 'activity', element: <ActivityView /> },
          { path: 'settings', element: <SettingsView /> },
        ],
      },
      {
        path: 'admin/users',
        element: (
          <RequireAdmin>
            <AdminUsersPage />
          </RequireAdmin>
        ),
      },
      {
        path: 'admin/sessions',
        element: (
          <RequireAdmin>
            <AdminSessionsPage />
          </RequireAdmin>
        ),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
