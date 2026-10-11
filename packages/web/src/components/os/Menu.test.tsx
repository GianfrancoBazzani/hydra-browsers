import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IconDots } from '@tabler/icons-react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { IconButton } from './Button';
import { OsIcon } from './icon';
import { Menu, MenuContent, MenuItem, MenuRadioGroup, MenuTrigger } from './Menu';

function MoreMenu({ onDelete }: { onDelete: () => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton aria-label="More">
          <OsIcon icon={IconDots} />
        </IconButton>
      </MenuTrigger>
      <MenuContent>
        <MenuItem onSelect={onDelete} destructive>
          Delete
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

function RoleMenu() {
  const [role, setRole] = useState<'viewer' | 'operator'>('viewer');
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button">Role: {role}</button>
      </MenuTrigger>
      <MenuContent>
        <MenuRadioGroup
          label="Role"
          value={role}
          onValueChange={setRole}
          options={[
            { value: 'viewer', label: 'Viewer' },
            { value: 'operator', label: 'Operator' },
          ]}
        />
      </MenuContent>
    </Menu>
  );
}

describe('Menu', () => {
  it('opens with the keyboard and runs the selected item', async () => {
    const onDelete = vi.fn();
    render(<MoreMenu onDelete={onDelete} />);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    const item = await screen.findByRole('menuitem', { name: 'Delete' });
    expect(item).toHaveClass('text-os-red-accessible');
    await userEvent.keyboard('{Enter}');
    expect(onDelete).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
  });

  it('closes with Esc and returns the focus to the trigger', async () => {
    render(<MoreMenu onDelete={vi.fn()} />);
    const trigger = screen.getByRole('button', { name: 'More' });
    await userEvent.click(trigger);
    expect(await screen.findByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it('selects a radio item', async () => {
    render(<RoleMenu />);
    await userEvent.click(screen.getByRole('button', { name: 'Role: viewer' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Viewer' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Operator' }));
    expect(await screen.findByRole('button', { name: 'Role: operator' })).toBeInTheDocument();
  });
});
