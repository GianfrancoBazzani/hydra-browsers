import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button } from './Button';
import { Sheet, SheetBody, SheetFooter } from './Sheet';

function Harness({ useReturnRef = false }: { useReturnRef?: boolean }) {
  const [open, setOpen] = useState(false);
  const other = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
        }}
      >
        New token
      </Button>
      <Button ref={other}>More</Button>
      <Sheet
        open={open}
        onOpenChange={setOpen}
        title="New token"
        description="The token permits the MCP endpoint of this session."
        {...(useReturnRef ? { returnFocusRef: other } : {})}
      >
        <SheetBody>
          <input aria-label="Name" />
        </SheetBody>
        <SheetFooter>
          <Button
            onClick={() => {
              setOpen(false);
            }}
          >
            Cancel
          </Button>
        </SheetFooter>
      </Sheet>
    </>
  );
}

describe('Sheet', () => {
  it('opens a modal dialog named by its title and described by its description', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'New token' }));
    const dialog = screen.getByRole('dialog', { name: 'New token' });
    expect(dialog).toHaveAccessibleDescription(
      'The token permits the MCP endpoint of this session.',
    );
    expect(dialog).toHaveClass('w-120', 'rounded-b-xl');
    expect(screen.getByLabelText('Name')).toHaveFocus();
  });

  it('closes with Esc and returns the focus to the opener', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'New token' });
    await userEvent.click(opener);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(opener).toHaveFocus();
    });
  });

  it('closes with Cancel', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('button', { name: 'New token' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('can return the focus to another control', async () => {
    render(<Harness useReturnRef />);
    await userEvent.click(screen.getByRole('button', { name: 'New token' }));
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
    });
  });
});
