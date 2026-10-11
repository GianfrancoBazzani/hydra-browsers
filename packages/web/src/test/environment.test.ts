import { MESSAGES } from '@hydra/shared';
import { describe, expect, it } from 'vitest';

describe('test environment', () => {
  it('loads @hydra/shared from source and has jsdom with the Testing Library matchers', () => {
    document.body.innerHTML = `<p>${MESSAGES.agentActive}</p>`;
    expect(document.querySelector('p')).toHaveTextContent('Agent active');
    expect(typeof ResizeObserver).toBe('function');
  });
});
