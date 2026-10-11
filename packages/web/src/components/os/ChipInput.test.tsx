import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { ChipInput } from './ChipInput';

function Harness({ initial = [] as string[] }) {
  const [value, setValue] = useState<string[]>(initial);
  return (
    <>
      <ChipInput label="Allowlist" value={value} onChange={setValue} />
      <output>{value.join('|')}</output>
    </>
  );
}

function chips() {
  return screen.getByRole('status').textContent;
}

describe('ChipInput', () => {
  it('adds a chip with Enter and with a comma', async () => {
    render(<Harness />);
    const input = screen.getByLabelText('Allowlist');
    await userEvent.type(input, 'example.com{Enter}');
    expect(chips()).toBe('example.com');
    await userEvent.type(input, '.github.com,');
    expect(chips()).toBe('example.com|.github.com');
    expect(input).toHaveValue('');
    const list = screen.getByRole('list', { name: 'Allowlist entries' });
    expect(list.children).toHaveLength(2);
  });

  it('removes the last chip with Backspace in an empty input', async () => {
    render(<Harness initial={['a.com', 'b.com']} />);
    const input = screen.getByLabelText('Allowlist');
    await userEvent.click(input);
    await userEvent.keyboard('{Backspace}');
    expect(chips()).toBe('a.com');
  });

  it('removes a chip with its remove button', async () => {
    render(<Harness initial={['a.com', 'b.com']} />);
    await userEvent.click(screen.getByRole('button', { name: 'Remove a.com' }));
    expect(chips()).toBe('b.com');
  });

  it('splits pasted text, ignores duplicates, and adds the rest on blur', () => {
    render(<Harness initial={['a.com']} />);
    const input = screen.getByLabelText('Allowlist');
    fireEvent.change(input, { target: { value: 'a.com, b.com, c.com' } });
    expect(chips()).toBe('a.com|b.com');
    expect(input).toHaveValue(' c.com');
    fireEvent.blur(input);
    expect(chips()).toBe('a.com|b.com|c.com');
  });

  it('does not submit the form when Enter adds a chip', async () => {
    let submitted = 0;
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted += 1;
        }}
      >
        <Harness />
      </form>,
    );
    await userEvent.type(screen.getByLabelText('Allowlist'), 'x.com{Enter}');
    expect(submitted).toBe(0);
    expect(chips()).toBe('x.com');
  });
});
