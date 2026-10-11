import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { CodeBlock } from './CodeBlock';

describe('CodeBlock', () => {
  it('copies the code with the Copy button', async () => {
    const user = userEvent.setup();
    render(<CodeBlock label="Claude Code command" code="claude mcp add x" />);
    expect(screen.getByRole('figure', { name: 'Claude Code command' })).toHaveTextContent(
      'claude mcp add x',
    );
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('claude mcp add x');
    expect(await screen.findByText('Copied')).toBeInTheDocument();
  });
});
