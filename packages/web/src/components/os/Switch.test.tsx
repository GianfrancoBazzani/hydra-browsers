import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Switch } from './Switch';

function Harness() {
  const [on, setOn] = useState(true);
  return <Switch label="Start now" checked={on} onCheckedChange={setOn} />;
}

describe('Switch', () => {
  it('is a labelled switch that toggles with a click and with Space', async () => {
    render(<Harness />);
    const control = screen.getByRole('switch', { name: 'Start now' });
    expect(control).toBeChecked();
    await userEvent.click(control);
    expect(control).not.toBeChecked();
    control.focus();
    await userEvent.keyboard(' ');
    expect(control).toBeChecked();
  });
});
