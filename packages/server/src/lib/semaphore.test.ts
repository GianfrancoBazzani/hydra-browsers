import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('runs at most max tasks at the same time and queues the others in order', async () => {
    const semaphore = new Semaphore(2);
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<undefined>());
    const started: number[] = [];
    const runs = gates.map((gate, index) =>
      semaphore.run(async () => {
        started.push(index);
        await gate.promise;
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    expect(semaphore.active).toBe(2);
    expect(semaphore.waiting).toBe(2);

    gates[1]?.resolve(undefined);
    await runs[1];
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);

    gates[0]?.resolve(undefined);
    gates[2]?.resolve(undefined);
    gates[3]?.resolve(undefined);
    expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
    expect(started).toEqual([0, 1, 2, 3]);
    expect(semaphore.active).toBe(0);
    expect(semaphore.waiting).toBe(0);
  });

  it('releases the slot when a task fails', async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.run(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await semaphore.run(() => Promise.resolve('next'))).toBe('next');
    expect(semaphore.active).toBe(0);
  });

  it('rejects a max that is not a positive integer', () => {
    expect(() => new Semaphore(0)).toThrow(RangeError);
    expect(() => new Semaphore(1.5)).toThrow(RangeError);
  });
});
