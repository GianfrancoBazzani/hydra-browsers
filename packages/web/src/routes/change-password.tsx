import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useChangePassword, useLogout } from '../api/auth';
import { errorMessage } from '../api/client';
import { Button, TextField } from '../components/os';
import { AuthPanel } from './auth-panel';
import { useCurrentUser } from './guards';

export function ChangePasswordPage() {
  const me = useCurrentUser();
  const change = useChangePassword();
  const logout = useLogout();
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const forced = me.mustChangePassword;
  const error = problem ?? (change.error ? errorMessage(change.error) : null);

  return (
    <AuthPanel title="Change password">
      {forced ? (
        <p className="text-os-base text-os-foreground">
          You logged in with a one-time password. Choose a new password to continue.
        </p>
      ) : null}
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          // Code points, like the server: an astral character is 2 UTF-16 units but 1 character.
          const length = [...next].length;
          if (length < 12 || length > 128) {
            setProblem('The new password must have 12 to 128 characters.');
            return;
          }
          if (next !== repeat) {
            setProblem('The two new passwords are not the same.');
            return;
          }
          setProblem(null);
          change.mutate(
            { current, new: next },
            {
              onSuccess: () => {
                void navigate('/', { replace: true });
              },
            },
          );
        }}
      >
        <TextField
          label="Current password"
          type="password"
          autoComplete="current-password"
          required
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
          }}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          hint="12 to 128 characters. A common password or your email is not accepted."
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
          }}
        />
        <TextField
          label="Repeat the new password"
          type="password"
          autoComplete="new-password"
          required
          value={repeat}
          onChange={(event) => {
            setRepeat(event.target.value);
          }}
        />
        {error ? (
          <p role="alert" className="text-os-base text-os-red-accessible">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          {forced ? (
            <Button
              variant="ghost"
              onClick={() => {
                logout.mutate(undefined, {
                  onSettled: () => {
                    void navigate('/login', { replace: true });
                  },
                });
              }}
            >
              Log out
            </Button>
          ) : (
            <Button
              onClick={() => {
                void navigate('/');
              }}
            >
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={change.isPending}>
            Change password
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}
