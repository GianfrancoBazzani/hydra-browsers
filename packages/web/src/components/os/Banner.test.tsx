import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Banner } from './Banner';

describe('Banner', () => {
  it('announces its text politely by default', () => {
    render(<Banner variant="info">Agent active</Banner>);
    const banner = screen.getByRole('status');
    expect(banner).toHaveTextContent('Agent active');
    expect(banner).toHaveClass('text-os-blue-accessible');
    expect(banner.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('can be an alert with the warning colors', () => {
    render(
      <Banner variant="warning" role="alert">
        More than one agent is connected
      </Banner>,
    );
    expect(screen.getByRole('alert')).toHaveClass('text-os-orange-accessible');
  });
});
