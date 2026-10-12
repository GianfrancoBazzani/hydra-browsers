import { describe, expect, it } from 'vitest';
import { currentTabIndex, tabLineMatchesUrl } from './current-tab.js';

const LIST = [
  '### Result',
  '- 0: [Home](https://a.com/)',
  '- 1: (current) [Login ](x) [y]](https://a.com/login?next=%2F)',
  '- 2: [Crashed](https://b.com/) [crashed]',
].join('\n');

describe('current tab', () => {
  it('reads the index of the current tab', () => {
    expect(currentTabIndex(LIST)).toBe(1);
    expect(currentTabIndex('No open tabs. Navigate to a URL to create one.')).toBeNull();
  });

  it('checks the URL at the end of the line of that tab', () => {
    expect(tabLineMatchesUrl(LIST, 1, 'https://a.com/login?next=%2F')).toBe(true);
    expect(tabLineMatchesUrl(LIST, 1, 'https://a.com/')).toBe(false);
    expect(tabLineMatchesUrl(LIST, 0, 'https://a.com/')).toBe(false); // not the current tab
  });
});
