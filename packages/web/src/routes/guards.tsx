import type { Me } from '@hydra/shared';
import { createContext, useContext, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useMe } from '../api/auth';
import { errorMessage } from '../api/client';
import { Button } from '../components/os';
import { AuthPanel } from './auth-panel';
import { NotFoundPage } from './shell/NotFoundPage';

const CurrentUserContext = createContext<Me | null>(null);

/** The logged-in user. Only for components under RequireLogin. */
export function useCurrentUser(): Me {
  const me = useContext(CurrentUserContext);
  if (!me) throw new Error('useCurrentUser needs RequireLogin');
  return me;
}

export interface RequireLoginProps {
  children: ReactNode;
  /** The Change password screen is the only screen while mustChangePassword is true. */
  allowPasswordChange?: boolean;
}

/** Sends people without a login session to Login, and forces Change password (spec 10.2). */
export function RequireLogin({ children, allowPasswordChange = false }: RequireLoginProps) {
  const me = useMe();
  const location = useLocation();

  if (me.data === undefined) {
    if (me.isError) {
      return (
        <AuthPanel title="Hydra Browsers">
          <p role="alert" className="text-os-base text-os-red-accessible">
            {errorMessage(me.error)}
          </p>
          <Button
            onClick={() => {
              void me.refetch();
            }}
          >
            Try again
          </Button>
        </AuthPanel>
      );
    }
    return (
      <AuthPanel title="Hydra Browsers">
        <p role="status" className="text-os-base text-os-gray-accessible">
          Loading…
        </p>
      </AuthPanel>
    );
  }
  if (me.data === null) {
    return (
      <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />
    );
  }
  if (me.data.mustChangePassword && !allowPasswordChange) {
    return <Navigate to="/change-password" replace />;
  }
  return <CurrentUserContext value={me.data}>{children}</CurrentUserContext>;
}

/** Admin screens. Members get the Not found page. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const me = useCurrentUser();
  if (me.role !== 'admin') return <NotFoundPage />;
  return children;
}
