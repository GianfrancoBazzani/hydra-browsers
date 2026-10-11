import { describe, expect, it } from 'vitest';
import { buildChromiumFlags } from './chromium-flags.js';
import { localeParts } from './locale.js';

describe('buildChromiumFlags', () => {
  it('adds the CDP port and the language flags through the Debian wrapper', () => {
    expect(buildChromiumFlags('en-US')).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=en-US --accept-lang=en-US,en"\n',
    );
  });

  it('gives one accept language when the tag has no region', () => {
    expect(buildChromiumFlags('de')).toBe(
      'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --remote-debugging-port=9222 --lang=de --accept-lang=de"\n',
    );
  });

  it('keeps the script subtag', () => {
    expect(buildChromiumFlags('zh-Hant-TW')).toContain(
      '--lang=zh-Hant-TW --accept-lang=zh-Hant-TW,zh"',
    );
  });
});

describe('localeParts', () => {
  it('splits a tag', () => {
    expect(localeParts('pt-BR')).toEqual({ tag: 'pt-BR', base: 'pt', posix: 'pt_BR' });
    expect(localeParts('fr')).toEqual({ tag: 'fr', base: 'fr', posix: 'fr' });
  });

  it('drops extensions', () => {
    expect(localeParts('en-US-u-ca-gregory').tag).toBe('en-US');
  });

  it('rejects a value that is not a language tag', () => {
    expect(() => localeParts('en"; rm -rf /; "')).toThrow();
  });
});
