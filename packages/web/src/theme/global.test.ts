import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read the stylesheet that the browser build uses.
const globalCss = readFileSync(join(import.meta.dirname, 'global.css'), 'utf8');

describe('global.css', () => {
  it('turns off movement under prefers-reduced-motion and keeps opacity transitions (STYLE.md section 2.7)', () => {
    const normalized = globalCss.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      '@media (prefers-reduced-motion: reduce) { *, ::before, ::after { transition-property: opacity !important; } }',
    );
  });
});
