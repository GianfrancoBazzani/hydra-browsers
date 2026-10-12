import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CountdownRing } from './CountdownRing';

describe('CountdownRing', () => {
  it('has a label and shows the part that is left', () => {
    render(<CountdownRing fraction={0.25} label="7 seconds left" />);
    const ring = screen.getByRole('img', { name: '7 seconds left' });
    const progress = ring.querySelectorAll('circle')[1];
    const length = Number(progress?.getAttribute('stroke-dasharray'));
    expect(Number(progress?.getAttribute('stroke-dashoffset'))).toBeCloseTo(length * 0.75);
  });

  it('keeps the fraction between 0 and 1', () => {
    render(<CountdownRing fraction={3} label="full" />);
    const progress = screen.getByRole('img', { name: 'full' }).querySelectorAll('circle')[1];
    expect(Number(progress?.getAttribute('stroke-dashoffset'))).toBe(0);
  });
});
