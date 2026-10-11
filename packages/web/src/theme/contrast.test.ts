import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, gradientColors, over, parseColor } from './contrast';
import { parseThemeTokens, type TokenMap } from './css-tokens';

// Read the files that the browser build uses, so that the test and the CSS cannot differ.
const tokensCss = readFileSync(join(import.meta.dirname, 'tokens.css'), 'utf8');

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

function color(tokens: TokenMap, name: string) {
  const value = tokens.get(name);
  if (value === undefined) throw new Error(`Missing token ${name}`);
  return parseColor(value);
}

describe('contrastRatio', () => {
  it('gives 21:1 for black on white and 1:1 for equal colors', () => {
    expect(contrastRatio(parseColor('#000'), parseColor('#fff'))).toBeCloseTo(21, 5);
    expect(contrastRatio(parseColor('#777'), parseColor('#777'))).toBe(1);
  });
});

describe.each([
  ['light', themes.light],
  ['dark', themes.dark],
] as const)('%s theme (STYLE.md section 8)', (theme, tokens) => {
  const surface = color(tokens, '--os-surface');
  const wallpaper = gradientColors(tokens.get('--os-wallpaper') ?? '');
  const backgrounds = [
    { name: 'surface', color: surface },
    ...wallpaper.flatMap((paper, i) => [
      { name: `surface 50% over wallpaper ${String(i)}`, color: over(surface, paper, 0.5) },
      { name: `surface 70% over wallpaper ${String(i)}`, color: over(surface, paper, 0.7) },
    ]),
  ];
  const textTokens = ['--os-foreground', ...SYSTEM_COLORS.map((c) => `--os-${c}-accessible`)];

  it('has two wallpaper colors', () => {
    expect(wallpaper).toHaveLength(2);
  });

  it.each(textTokens)('%s has 4.5:1 on all window backgrounds', (token) => {
    const fg = color(tokens, token);
    for (const bg of backgrounds) {
      const ratio = contrastRatio(fg, bg.color);
      expect(ratio, `${token} on ${bg.name}: ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['--os-accent-fill', '--os-danger-fill'])('--os-on-fill has 4.5:1 on %s', (fill) => {
    const ratio = contrastRatio(color(tokens, '--os-on-fill'), color(tokens, fill));
    expect(ratio, ratio.toFixed(2)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SYSTEM_COLORS)('the accessible %s (dot border) has 3:1 on the surface', (name) => {
    const ratio = contrastRatio(color(tokens, `--os-${name}-accessible`), surface);
    expect(ratio, ratio.toFixed(2)).toBeGreaterThanOrEqual(3);
  });

  it('the focus ring (--os-accent) has 3:1 on the surface', () => {
    const ratio = contrastRatio(color(tokens, '--os-accent'), surface);
    expect(ratio, ratio.toFixed(2)).toBeGreaterThanOrEqual(3);
  });

  // STYLE.md section 8: the table header text on its background (STYLE.md section 5, "Table").
  it('table header text has 4.5:1 on the header background', () => {
    const header = color(tokens, theme === 'light' ? '--os-gray-6' : '--os-gray-5');
    const ratio = contrastRatio(color(tokens, '--os-gray-accessible'), header);
    expect(ratio, ratio.toFixed(2)).toBeGreaterThanOrEqual(4.5);
  });

  // A pair that the Banner component adds (STYLE.md section 5, "Banner").
  it.each(['blue', 'orange'])('%s banner text has 4.5:1 on the banner background', (name) => {
    const background = over(color(tokens, `--os-${name}`), surface, 0.12);
    const ratio = contrastRatio(color(tokens, `--os-${name}-accessible`), background);
    expect(ratio, ratio.toFixed(2)).toBeGreaterThanOrEqual(4.5);
  });
});
