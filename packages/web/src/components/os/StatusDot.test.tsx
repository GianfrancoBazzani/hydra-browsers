import { render, screen } from '@testing-library/react';
import { SESSION_STATES } from '@hydra/shared';
import { describe, expect, it } from 'vitest';
import { SESSION_STATE_LABELS, StatusDot } from './StatusDot';

describe('StatusDot', () => {
  it.each(SESSION_STATES)('has a visually hidden text for %s', (state) => {
    render(<StatusDot state={state} />);
    const text = screen.getByText(SESSION_STATE_LABELS[state]);
    expect(text).toHaveClass('sr-only');
  });

  it('uses the colors of the spec for the main states', () => {
    const { container, rerender } = render(<StatusDot state="running" />);
    const dot = () => container.querySelector('[data-state]');
    expect(dot()).toHaveClass('bg-os-green', 'border-os-green-accessible');
    expect(dot()).toHaveAttribute('aria-hidden', 'true');
    rerender(<StatusDot state="starting" />);
    expect(dot()).toHaveClass('bg-os-yellow');
    rerender(<StatusDot state="stopping" />);
    expect(dot()).toHaveClass('bg-os-yellow');
    rerender(<StatusDot state="stopped" />);
    expect(dot()).toHaveClass('bg-os-gray');
    rerender(<StatusDot state="error" />);
    expect(dot()).toHaveClass('bg-os-red', 'border-os-red-accessible');
  });

  it('can show the state name', () => {
    render(<StatusDot state="error" showLabel />);
    expect(screen.getByText('Error')).not.toHaveClass('sr-only');
  });
});
