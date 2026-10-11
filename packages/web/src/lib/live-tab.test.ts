import { describe, expect, it, vi } from 'vitest';
import { LiveTabRegistry } from './live-tab';

describe('LiveTabRegistry', () => {
  it('ends the grant of the previous session before another session opens', async () => {
    const endGrant = vi.fn(() => Promise.resolve());
    const tab = new LiveTabRegistry(endGrant);
    await tab.beforeOpen('aaaaaaaaaaaa');
    expect(endGrant).not.toHaveBeenCalled();
    tab.opened('aaaaaaaaaaaa');
    await tab.beforeOpen('aaaaaaaaaaaa');
    expect(endGrant).not.toHaveBeenCalled();
    await tab.beforeOpen('bbbbbbbbbbbb');
    expect(endGrant).toHaveBeenCalledExactlyOnceWith('aaaaaaaaaaaa');
  });

  it('lets a second caller wait for the same pending end, and ignores errors', async () => {
    let finish: () => void = () => undefined;
    const endGrant = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          finish = () => {
            reject(new Error('offline'));
          };
        }),
    );
    const tab = new LiveTabRegistry(endGrant);
    tab.opened('aaaaaaaaaaaa');
    const first = tab.beforeOpen('bbbbbbbbbbbb');
    const second = tab.beforeOpen('bbbbbbbbbbbb');
    let settled = false;
    void second.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(endGrant).toHaveBeenCalledTimes(1);
  });
});
