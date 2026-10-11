import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { TextField } from './TextField';

describe('TextField', () => {
  it('connects the label to the input', async () => {
    render(<TextField label="Email" />);
    const input = screen.getByLabelText('Email');
    await userEvent.type(input, 'ana@example.com');
    expect(input).toHaveValue('ana@example.com');
  });

  it('marks the input invalid and describes it with the error', () => {
    render(<TextField label="Name" error="Use 1 to 64 characters" hint="Shown in the sidebar" />);
    const input = screen.getByLabelText('Name');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Use 1 to 64 characters');
    expect(screen.queryByText('Shown in the sidebar')).not.toBeInTheDocument();
  });

  it('shows the hint when there is no error', () => {
    render(<TextField label="Timezone" hint="IANA name" />);
    expect(screen.getByLabelText('Timezone')).toHaveAccessibleDescription('IANA name');
    expect(screen.getByLabelText('Timezone')).not.toHaveAttribute('aria-invalid');
  });
});
