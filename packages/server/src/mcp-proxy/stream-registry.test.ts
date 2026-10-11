import { describe, expect, it, vi } from 'vitest';
import { StreamRegistry } from './stream-registry.js';

const owner = (tokenId: string, userId: string, sessionId: string) => ({
  tokenId,
  userId,
  sessionId,
});

describe('StreamRegistry', () => {
  it('counts registered entries and removes an entry with the returned function', () => {
    const registry = new StreamRegistry();
    const unregister = registry.register({ ...owner('t1', 'u1', 's1'), abort: vi.fn() });
    registry.register({ ...owner('t2', 'u1', 's1'), abort: vi.fn() });
    expect(registry.size()).toBe(2);
    unregister();
    unregister();
    expect(registry.size()).toBe(1);
  });

  it('aborts and removes only the matching entries, with the reason', () => {
    const registry = new StreamRegistry();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    registry.register({ ...owner('t1', 'u1', 's1'), abort: a });
    registry.register({ ...owner('t1', 'u1', 's1'), abort: b });
    registry.register({ ...owner('t2', 'u2', 's2'), abort: c });
    expect(registry.closeWhere((entry) => entry.tokenId === 't1', 'token revoked')).toBe(2);
    expect(a).toHaveBeenCalledWith('token revoked');
    expect(b).toHaveBeenCalledWith('token revoked');
    expect(c).not.toHaveBeenCalled();
    expect(registry.size()).toBe(1);
    expect(registry.closeWhere((entry) => entry.tokenId === 't1', 'again')).toBe(0);
  });

  it('gives the predicate the owner fields only', () => {
    const registry = new StreamRegistry();
    registry.register({ ...owner('t1', 'u1', 's1'), abort: vi.fn() });
    const seen: unknown[] = [];
    registry.closeWhere((entry) => {
      seen.push(entry);
      return false;
    }, 'none');
    expect(seen).toEqual([{ tokenId: 't1', userId: 'u1', sessionId: 's1' }]);
  });

  it('continues when one abort throws', () => {
    const registry = new StreamRegistry();
    const second = vi.fn();
    registry.register({
      ...owner('t1', 'u1', 's1'),
      abort: () => {
        throw new Error('socket already gone');
      },
    });
    registry.register({ ...owner('t1', 'u1', 's1'), abort: second });
    expect(registry.closeWhere(() => true, 'shutdown')).toBe(2);
    expect(second).toHaveBeenCalledWith('shutdown');
    expect(registry.size()).toBe(0);
  });

  it('does not fail when an entry unregisters itself during its abort', () => {
    const registry = new StreamRegistry();
    const unregisters: (() => void)[] = [];
    unregisters.push(
      registry.register({
        ...owner('t1', 'u1', 's1'),
        abort: () => {
          for (const unregister of unregisters) unregister();
        },
      }),
    );
    expect(registry.closeWhere(() => true, 'x')).toBe(1);
    expect(registry.size()).toBe(0);
  });
});
