import type { Logger } from './logger.js';

/**
 * Waits for `promise` at most `ms`. At the deadline it logs a warning and returns, so the caller
 * goes on (shutdown must always close the database). A rejection before the deadline is passed on;
 * a rejection after the deadline is ignored.
 */
export function withDeadline(
  promise: Promise<unknown>,
  ms: number,
  label: string,
  logger: Logger,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      logger.warn({ label, deadlineMs: ms }, `${label} did not finish in time, continuing`);
      resolve();
    }, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
