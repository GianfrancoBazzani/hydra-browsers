import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/** stdin as the prompt sees it: a TTY can switch to raw mode, so the typed text is not shown. */
export type SecretInput = Readable & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };

export class PromptCancelledError extends Error {
  constructor(message = 'Cancelled.') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

/** True if the input is a terminal that can hide the typed text (raw mode). */
export function isInteractive(input: SecretInput = process.stdin): boolean {
  return input.isTTY === true && typeof input.setRawMode === 'function';
}

const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

function readTtySecret(prompt: string, input: SecretInput, output: Writable): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = '';
    output.write(prompt);
    input.setRawMode?.(true);
    input.setEncoding('utf8');
    input.resume();
    const finish = (error: Error | null): void => {
      input.off('data', onData);
      input.setRawMode?.(false);
      input.pause();
      output.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (ENTER.has(char)) return finish(null);
        if (char === CTRL_C) return finish(new PromptCancelledError());
        if (char === CTRL_D) {
          return finish(value === '' ? new PromptCancelledError() : null);
        }
        if (BACKSPACE.has(char)) value = [...value].slice(0, -1).join('');
        else value += char;
      }
    };
    input.on('data', onData);
  });
}

/**
 * Returns a function that reads a secret (spec section 6.3).
 * - On a TTY: writes the prompt and reads one line; the typed characters are not shown (raw mode).
 * - Without a TTY (for example `printf '%s\n' "$PASSWORD" | kubectl exec -i … -- hydra user
 *   create …`): writes no prompt and returns the next line of the input.
 */
export function createSecretReader(
  input: SecretInput = process.stdin,
  output: Writable = process.stderr,
): (prompt: string) => Promise<string> {
  if (isInteractive(input)) return (prompt) => readTtySecret(prompt, input, output);
  const lines = createInterface({ input, terminal: false })[Symbol.asyncIterator]();
  return async () => {
    const next = await lines.next();
    if (next.done === true) throw new PromptCancelledError('No password on stdin.');
    return String(next.value);
  };
}
