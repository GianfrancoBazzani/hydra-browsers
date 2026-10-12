import { describe, expect, it } from 'vitest';
import { CdpBrowser } from './browser.js';

describe('CdpBrowser', () => {
  it('tries again while Chromium does not answer, and never throws', async () => {
    const errors: string[] = [];
    const browser = new CdpBrowser(
      'http://127.0.0.1:1',
      { info: () => undefined, error: (message) => errors.push(message) },
      10,
    );
    const done = browser.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));
    browser.stop();
    await expect(done).resolves.toBeUndefined();
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(browser.context).toBeNull();
  });
});
