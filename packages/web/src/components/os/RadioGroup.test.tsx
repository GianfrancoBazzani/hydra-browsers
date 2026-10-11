import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { RadioGroup } from './RadioGroup';

const OPTIONS = [
  { value: '1280x720', label: '1280 × 720' },
  { value: '1600x900', label: '1600 × 900' },
  { value: '1920x1080', label: '1920 × 1080' },
] as const;

function Harness() {
  const [value, setValue] = useState<(typeof OPTIONS)[number]['value']>('1920x1080');
  return (
    <>
      <RadioGroup label="Screen" value={value} options={OPTIONS} onValueChange={setValue} />
      <output>{value}</output>
    </>
  );
}

describe('RadioGroup', () => {
  it('is a labelled radio group that works with clicks and the keyboard', async () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Screen' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '1920 × 1080' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: '1280 × 720' }));
    expect(screen.getByRole('status')).toHaveTextContent('1280x720');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '1600 × 900' })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('status')).toHaveTextContent('1600x900');
  });
});
