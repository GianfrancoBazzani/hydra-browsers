import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const VIEWS = [
  { value: 'live', label: 'Live' },
  { value: 'tokens', label: 'Tokens' },
  { value: 'settings', label: 'Settings' },
] as const;

function Harness() {
  const [view, setView] = useState<(typeof VIEWS)[number]['value']>('live');
  return (
    <>
      <SegmentedControl label="Views" value={view} segments={VIEWS} onValueChange={setView} />
      <output>{view}</output>
    </>
  );
}

describe('SegmentedControl', () => {
  it('is a labelled radio group with the selected segment checked', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Views' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Tokens' })).toHaveAttribute('aria-checked', 'false');
  });

  it('moves the focus with the arrow keys and selects with Enter', async () => {
    render(<Harness />);
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Tokens' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Settings' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}{Enter}');
    expect(screen.getByRole('status')).toHaveTextContent('settings');
    expect(screen.getByRole('radio', { name: 'Settings' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps the selection when the selected segment is clicked again', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole('radio', { name: 'Live' }));
    expect(screen.getByRole('status')).toHaveTextContent('live');
    expect(screen.getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
  });
});
