/** Token values of one theme: CSS custom property name → raw value. */
export type TokenMap = ReadonlyMap<string, string>;

export interface ThemeTokens {
  light: TokenMap;
  dark: TokenMap;
}

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  const withoutComments = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of withoutComments.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name && value) map.set(name, value.replace(/\s+/g, ' ').trim());
  }
  return map;
}

function blockAfter(css: string, start: number): string {
  const open = css.indexOf('{', start);
  if (open < 0) throw new Error(`No block after offset ${String(start)}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`Unclosed block at offset ${String(open)}`);
}

/**
 * Reads tokens.css: the first `:root { … }` block gives the light values, and the
 * `:root` block inside `@media (prefers-color-scheme: dark)` overrides them for dark.
 */
export function parseThemeTokens(css: string): ThemeTokens {
  const rootStart = css.search(/(^|\n):root\s*\{/);
  if (rootStart < 0) throw new Error('tokens.css has no :root block');
  const light = declarations(blockAfter(css, rootStart));
  const mediaStart = css.search(/@media\s*\(prefers-color-scheme:\s*dark\)/);
  if (mediaStart < 0) throw new Error('tokens.css has no dark block');
  const media = blockAfter(css, mediaStart);
  const darkRoot = media.search(/:root\s*\{/);
  if (darkRoot < 0) throw new Error('The dark block has no :root block');
  const dark = new Map(light);
  for (const [name, value] of declarations(blockAfter(media, darkRoot))) dark.set(name, value);
  return { light, dark };
}

/** Reads the `@theme inline { … }` block. */
export function parseThemeMapping(css: string): TokenMap {
  const start = css.search(/@theme\s+inline\s*\{/);
  if (start < 0) throw new Error('tokens.css has no @theme inline block');
  return declarations(blockAfter(css, start));
}
