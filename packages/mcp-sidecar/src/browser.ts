// The CDP connection to the Chromium of the neko container (spec section 8.8.3).
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium, type BrowserContext } from 'playwright';

/** Spec section 8.8.3: the sidecar tries again every 1 s. */
export const CDP_RETRY_MS = 1_000;

export interface Log {
  info(message: string): void;
  error(message: string, err?: unknown): void;
}

export class CdpBrowser {
  readonly #endpoint: string;
  readonly #log: Log;
  readonly #retryMs: number;
  readonly #listeners = new Set<() => void>();
  #context: BrowserContext | null = null;
  #stopped = false;

  constructor(endpoint: string, log: Log, retryMs = CDP_RETRY_MS) {
    this.#endpoint = endpoint;
    this.#log = log;
    this.#retryMs = retryMs;
  }

  /** The first browser context of Chromium (its profile), or null while the sidecar is not connected. */
  get context(): BrowserContext | null {
    return this.#context;
  }

  onDisconnect(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Connects. If Chromium does not answer, it tries again every retryMs, until it connects or stop() runs. */
  async connect(): Promise<void> {
    while (!this.#stopped) {
      try {
        const browser = await chromium.connectOverCDP(this.#endpoint);
        const context = browser.contexts()[0];
        if (context === undefined) {
          await browser.close();
          throw new Error('Chromium has no browser context');
        }
        browser.once('disconnected', () => {
          this.#context = null;
          for (const listener of [...this.#listeners]) listener();
        });
        this.#context = context;
        this.#log.info(`connected to ${this.#endpoint}`);
        return;
      } catch (err) {
        this.#log.error(
          `cannot connect to ${this.#endpoint}, next try in ${String(this.#retryMs)} ms`,
          err,
        );
        await sleep(this.#retryMs);
      }
    }
  }

  stop(): void {
    this.#stopped = true;
  }
}
