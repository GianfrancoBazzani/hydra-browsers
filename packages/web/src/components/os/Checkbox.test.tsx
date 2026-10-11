import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Checkbox } from './Checkbox';

function Harness() {
  const [on, setOn] = useState(false);
  return <Checkbox label="Administrator" checked={on} onCheckedChange={setOn} />;
}

describe('Checkbox', () => {
  it('toggles with a click on its label and with Space', async () => {
    render(<Harness />);
    const box = screen.getByRole('checkbox', { name: 'Administrator' });
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByText('Administrator'));
    expect(box).toBeChecked();
    box.focus();
    await userEvent.keyboard(' ');
    expect(box).not.toBeChecked();
  });
});
