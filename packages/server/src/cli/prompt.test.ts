import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  PromptCancelledError,
  createSecretReader,
  isInteractive,
  type SecretInput,
} from './prompt.js';

function tty(): { input: SecretInput & PassThrough; setRawMode: ReturnType<typeof vi.fn> } {
  const setRawMode = vi.fn();
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode });
  return { input, setRawMode };
}

function capture(): { output: PassThrough; text(): string } {
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return { output, text: () => text };
}

describe('createSecretReader on a TTY', () => {
  it('reads without echo, handles backspace, and restores the mode', async () => {
    const { input, setRawMode } = tty();
    const out = capture();
    const read = createSecretReader(input, out.output);
    const answer = read('Password: ');
    input.write('abc\u007fd\r');
    expect(await answer).toBe('abd');
    expect(out.text()).toBe('Password: \n');
    expect(setRawMode.mock.calls).toEqual([[true], [false]]);
  });

  it('rejects on Ctrl-C', async () => {
    const { input } = tty();
    const read = createSecretReader(input, capture().output);
    const answer = read('Password: ');
    input.write('ab\u0003');
    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
  });
});

describe('createSecretReader without a TTY', () => {
  it('reads the next line for each call and writes no prompt', async () => {
    const input = new PassThrough();
    const out = capture();
    const read = createSecretReader(input, out.output);
    input.write('first secret\nsecond secret\n');
    expect(await read('Password: ')).toBe('first secret');
    expect(await read('Repeat: ')).toBe('second secret');
    expect(out.text()).toBe('');
  });

  it('reads a last line without a line end', async () => {
    const input = new PassThrough();
    const read = createSecretReader(input, capture().output);
    input.end('only secret');
    expect(await read('Password: ')).toBe('only secret');
  });

  it('rejects when the input ends', async () => {
    const input = new PassThrough();
    const read = createSecretReader(input, capture().output);
    input.end();
    const answer = read('Password: ');
    await expect(answer).rejects.toBeInstanceOf(PromptCancelledError);
    await expect(answer).rejects.toThrow('No password on stdin.');
  });
});

describe('isInteractive', () => {
  it('is true only for a TTY that has raw mode', () => {
    expect(isInteractive(tty().input)).toBe(true);
    expect(isInteractive(new PassThrough())).toBe(false);
    expect(isInteractive(Object.assign(new PassThrough(), { isTTY: true }))).toBe(false);
  });
});
