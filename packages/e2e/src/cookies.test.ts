import { describe, expect, it } from 'vitest';
import { findCookie } from './cookies.js';

describe('findCookie', () => {
  it('finds the pair in a document.cookie string', () => {
    expect(findCookie('a=1; hydra_test=k9Xc2; b=2', 'hydra_test')).toBe('hydra_test=k9Xc2');
    expect(findCookie('hydra_test=k9Xc2', 'hydra_test')).toBe('hydra_test=k9Xc2');
  });

  it('does not match a cookie whose name only starts with the name', () => {
    expect(findCookie('hydra_test_old=1', 'hydra_test')).toBeUndefined();
  });

  it('returns undefined for a value that is not a string', () => {
    expect(findCookie(undefined, 'hydra_test')).toBeUndefined();
    expect(findCookie({ cookie: 'hydra_test=1' }, 'hydra_test')).toBeUndefined();
  });
});
