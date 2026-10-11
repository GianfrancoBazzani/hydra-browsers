import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseThemeMapping, parseThemeTokens } from './css-tokens';

// Read the files that the browser build uses, so that the test and the CSS cannot differ.
const tokensCss = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');
const styleMd = readFileSync(join(import.meta.dirname, '../../../../STYLE.md'), 'utf8');

const SYSTEM_COLORS = [
  'red',
  'orange',
  'yellow',
  'green',
  'mint',
  'teal',
  'cyan',
  'blue',
  'indigo',
  'purple',
  'pink',
  'brown',
  'gray',
] as const;

const themes = parseThemeTokens(tokensCss);
const mapping = parseThemeMapping(tokensCss);

/** The rows of the token table under a STYLE.md heading, as the first code span of each cell. */
function tableRows(heading: string): string[][] {
  const start = styleMd.indexOf(heading);
  if (start < 0) throw new Error(`STYLE.md has no heading ${heading}`);
  const end = styleMd.indexOf('\n### ', start + heading.length);
  const section = styleMd.slice(start, end < 0 ? undefined : end);
  return section
    .split('\n')
    .filter((line) => line.startsWith('| `--os-'))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => (/`([^`]+)`/.exec(cell)?.[1] ?? cell).trim().toLowerCase()),
    );
}

describe('tokens.css', () => {
  it('defines every token that STYLE.md names, and no other token', () => {
    const documented = new Set([...styleMd.matchAll(/`(--os-[a-z0-9-]+)`/g)].map((m) => m[1]));
    // STYLE.md section 2.1: "The accessible token of each color is `--os-<color>-accessible`".
    for (const name of SYSTEM_COLORS) documented.add(`--os-${name}-accessible`);
    const defined = new Set(themes.light.keys());
    expect([...documented].filter((name) => name !== undefined && !defined.has(name))).toEqual([]);
    expect([...defined].filter((name) => !documented.has(name))).toEqual([]);
  });

  it('has the system color values of STYLE.md section 2.1', () => {
    const rows = tableRows('### 2.1 System colors');
    expect(rows).toHaveLength(SYSTEM_COLORS.length);
    for (const [token = '', light, dark, accessibleLight, accessibleDark] of rows) {
      expect(themes.light.get(token), token).toBe(light);
      expect(themes.dark.get(token), token).toBe(dark);
      expect(themes.light.get(`${token}-accessible`), token).toBe(accessibleLight);
      expect(themes.dark.get(`${token}-accessible`), token).toBe(accessibleDark);
    }
  });

  it('has the surface values of STYLE.md section 2.2', () => {
    const rows = tableRows('### 2.2 Surface tokens');
    expect(rows.length).toBeGreaterThan(15);
    for (const [token = '', light, dark] of rows) {
      expect(themes.light.get(token), token).toBe(light);
      expect(themes.dark.get(token), token).toBe(dark);
    }
  });

  it('has the wallpaper and traffic light values of STYLE.md section 2.3', () => {
    for (const [token = '', light, dark] of tableRows('### 2.3 Wallpaper and traffic lights')) {
      expect(themes.light.get(token), token).toBe(light);
      expect(themes.dark.get(token), token).toBe(dark === 'same' ? light : dark);
    }
  });

  it('maps the tokens for Tailwind (STYLE.md section 9)', () => {
    for (const name of SYSTEM_COLORS) {
      expect(mapping.get(`--color-os-${name}`)).toBe(`var(--os-${name})`);
      expect(mapping.get(`--color-os-${name}-accessible`)).toBe(`var(--os-${name}-accessible)`);
    }
    for (const [key, value] of mapping) {
      const ref = /^var\((--os-[a-z0-9-]+)\)$/.exec(value)?.[1];
      if (ref) expect(themes.light.has(ref), `${key} → ${ref}`).toBe(true);
    }
    expect(mapping.get('--color-os-surface')).toBe('var(--os-surface)');
    expect(mapping.get('--text-os-base')).toBe('13px');
    expect(mapping.get('--text-os-base--line-height')).toBe('18px');
    expect(mapping.get('--shadow-os-window')).toBe('var(--os-shadow-window)');
    expect(mapping.get('--font-sans')).toBe('var(--os-font-sans)');
  });
});
