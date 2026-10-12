import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createRedactor, vaultLabel } from '../vault/index.js';
import { bodyModeOf, createRedactionTransform, type BodyMode } from './redact-stream.js';

const ID = '01J9ZC0000000000000000CRD1';
const LABEL = vaultLabel(ID, 'password');
const VALUE = 'pä"ss🔑word';
const redactor = createRedactor([{ value: VALUE, label: LABEL }]);

async function run(mode: BodyMode, chunks: Array<string | Buffer>, r = redactor): Promise<string> {
  const out = new PassThrough();
  const result = text(out);
  await pipeline(
    Readable.from(chunks.map((chunk) => (typeof chunk === 'string' ? Buffer.from(chunk) : chunk))),
    createRedactionTransform(mode, () => r),
    out,
  );
  return result;
}

function message(textValue: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: textValue }] },
  });
}

describe('bodyModeOf', () => {
  it('uses the status and the content type', () => {
    expect(bodyModeOf(200, 'text/event-stream; charset=utf-8')).toBe('sse');
    expect(bodyModeOf(200, 'application/json')).toBe('json');
    expect(bodyModeOf(404, 'application/json')).toBe('other');
  });
});

describe('createRedactionTransform', () => {
  it('redacts a JSON body', async () => {
    expect(await run('json', [message(`pw ${VALUE}`)])).toBe(message(`pw ${LABEL}`));
  });

  it('redacts an SSE event that arrives one byte at a time, also inside a UTF-8 character and \\r\\n', async () => {
    const event = `event: message\r\nid: 5\r\ndata: ${message(`pw ${VALUE}`)}\r\n\r\n`;
    const bytes = Buffer.from(event);
    const chunks = Array.from(bytes, (byte) => Buffer.from([byte]));
    expect(await run('sse', chunks)).toBe(
      `event: message\r\nid: 5\r\ndata: ${message(`pw ${LABEL}`)}\n\r\n`,
    );
  });

  it('joins data lines, keeps comments, and passes events without data', async () => {
    const json = message(`a ${VALUE}`);
    const input = `: ping\n\nretry: 100\n\ndata: ${json.slice(0, 20)}\ndata: ${json.slice(20)}\n\n`;
    const output = await run('sse', [input]);
    expect(output.startsWith(': ping\n\nretry: 100\n\n')).toBe(true);
    expect(output).toContain(LABEL);
    expect(output).not.toContain('🔑');
  });

  it('keeps a bare \\r line end at the end of a chunk and at the end of the stream', async () => {
    expect(await run('sse', ['id: 1\r', '\r', ': c\r'])).toBe('id: 1\r\r: c\r');
    expect(await run('sse', [`data: ${message(VALUE)}\r`, '\r'])).toBe(
      `data: ${message(LABEL)}\n\r`,
    );
  });

  it('scans a long SSE line in linear time (no copy of the buffered part for each chunk)', async () => {
    const text = 'x'.repeat(32 * 1024 * 1024);
    const event = Buffer.from(`data: ${message(text)}\n\n`);
    const chunks: Buffer[] = [];
    for (let i = 0; i < event.length; i += 16 * 1024) chunks.push(event.subarray(i, i + 16 * 1024));
    const started = performance.now();
    const output = await run('sse', chunks);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(output.length).toBe(event.length);
  }, 30_000);

  it('redacts the raw text of other bodies', async () => {
    expect(await run('other', [`Internal error ${VALUE}`])).toBe(`Internal error ${LABEL}`);
  });

  it('sends the bytes without a change when the redactor is empty', async () => {
    const empty = createRedactor([]);
    const body = `data: {"a":1}\n\n: x\n`;
    expect(await run('sse', [body], empty)).toBe(body);
    expect(await run('json', ['{ "a" : 1 }'], empty)).toBe('{ "a" : 1 }');
  });
});
