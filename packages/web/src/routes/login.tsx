import { MESSAGES } from '@hydra/shared';
import { useState } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useLogin, useMe } from '../api/auth';
import { errorMessage, isApiError } from '../api/client';
import { Button, TextField } from '../components/os';
import { AuthPanel } from './auth-panel';

/** The page to open after the login: the page that sent the user to Login, or the start. */
function returnPath(state: unknown): string {
  if (typeof state === 'object' && state !== null && 'from' in state) {
    const { from } = state;
    if (typeof from === 'string' && from.startsWith('/') && !from.startsWith('//')) return from;
  }
  return '/';
}

export function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  // After a good login, useLogin stores the user, and this redirect opens the next screen.
  if (me.data) {
    const next = me.data.mustChangePassword ? '/change-password' : returnPath(location.state);
    return <Navigate to={next} replace />;
  }

  const error = login.error
    ? isApiError(login.error, 'invalid_credentials')
      ? MESSAGES.invalidCredentials
      : errorMessage(login.error)
    : null;

  return (
    <AuthPanel title="Hydra Browsers">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          login.mutate({ email: email.trim(), password });
        }}
      >
        <TextField
          label="Email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {error ? (
          <p role="alert" className="text-os-base text-os-red-accessible">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={login.isPending}>
          Log in
        </Button>
      </form>
    </AuthPanel>
  );
}
