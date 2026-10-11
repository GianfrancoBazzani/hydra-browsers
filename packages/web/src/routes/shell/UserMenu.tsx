import { IconSelector, IconUserCircle } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import { useLogout } from '../../api/auth';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, OsIcon } from '../../components/os';
import { useCurrentUser } from '../guards';

/** The user menu at the bottom of the sidebar: change password, logout (spec section 10.2). */
export function UserMenu() {
  const me = useCurrentUser();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="flex h-(--os-row-height) w-full items-center gap-2 rounded-os-control px-2 text-left text-os-base text-os-foreground hover:bg-os-tone"
        >
          <OsIcon icon={IconUserCircle} size={18} />
          <span className="min-w-0 flex-1 truncate">{me.displayName}</span>
          <OsIcon icon={IconSelector} />
        </button>
      </MenuTrigger>
      <MenuContent align="start" side="top">
        <MenuLabel>{me.email}</MenuLabel>
        <MenuItem
          onSelect={() => {
            void navigate('/change-password');
          }}
        >
          Change password
        </MenuItem>
        <MenuItem
          onSelect={() => {
            logout.mutate(undefined, {
              onSettled: () => {
                void navigate('/login', { replace: true });
              },
            });
          }}
        >
          Log out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}
