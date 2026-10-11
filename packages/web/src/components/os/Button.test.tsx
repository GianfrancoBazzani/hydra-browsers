import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IconPlus } from '@tabler/icons-react';
import { describe, expect, it, vi } from 'vitest';
import { Button, IconButton } from './Button';
import { OsIcon } from './icon';

describe('Button', () => {
  it('is a type="button" button that calls onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Start</Button>);
    const button = screen.getByRole('button', { name: 'Start' });
    expect(button).toHaveAttribute('type', 'button');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('uses the fill tokens for primary and destructive buttons', () => {
    render(
      <>
        <Button variant="primary">Create</Button>
        <Button variant="destructive">Delete</Button>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Create' })).toHaveClass(
      'bg-os-accent-fill',
      'text-os-on-fill',
    );
    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass(
      'bg-os-danger-fill',
      'text-os-on-fill',
    );
  });

  it('does not call onClick when disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Stop
      </Button>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('works with the keyboard', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Restart</Button>);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Restart' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('IconButton', () => {
  it('takes its accessible name from aria-label and hides the icon', () => {
    render(
      <IconButton aria-label="New session">
        <OsIcon icon={IconPlus} />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'New session' });
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button).toHaveClass('h-(--os-control-height-sm)', 'w-(--os-control-height-sm)');
  });

  it('has no horizontal padding, so that the icon stays centered in a square', () => {
    render(
      <>
        <Button>Start</Button>
        <IconButton aria-label="New session">
          <OsIcon icon={IconPlus} />
        </IconButton>
      </>,
    );
    expect(screen.getByRole('button', { name: 'Start' }).classList).toContain('px-3');
    expect(screen.getByRole('button', { name: 'New session' }).classList).not.toContain('px-3');
  });
});
