/** Limits the number of async tasks that run at the same time. Other tasks wait in FIFO order. */
export class Semaphore {
  readonly #max: number;
  readonly #waiting: (() => void)[] = [];
  #active = 0;

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('max must be a positive integer');
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  get waiting(): number {
    return this.#waiting.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  #release(): void {
    const next = this.#waiting.shift();
    // The slot goes directly to the next task, so #active does not change.
    if (next) next();
    else this.#active -= 1;
  }
}
