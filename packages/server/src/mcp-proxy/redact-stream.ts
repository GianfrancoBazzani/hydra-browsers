// The redaction stage of an MCP response (spec section 8.9). It runs before the audit copy.
import { Transform, type TransformCallback } from 'node:stream';
import type { Redactor } from '../vault/index.js';

export type BodyMode = 'sse' | 'json' | 'other';

/** Spec section 8.9: a JSON body or one SSE event is redacted as a whole, up to 64 MiB. */
export const MAX_REDACTED_BODY_BYTES = 64 * 1024 * 1024;
const TOO_LARGE = 'The response is too large to redact.';

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export function bodyModeOf(status: number, contentType: string): BodyMode {
  const type = contentType.toLowerCase();
  const success = status >= 200 && status < 300;
  if (success && type.startsWith('text/event-stream')) return 'sse';
  if (success && type.startsWith('application/json')) return 'json';
  return 'other';
}

/** A JSON body (or another body): all of it, then one write. */
class BodyRedactor extends Transform {
  readonly #mode: 'json' | 'other';
  readonly #redactor: () => Redactor;
  readonly #chunks: Buffer[] = [];
  #size = 0;

  constructor(mode: 'json' | 'other', redactor: () => Redactor) {
    super();
    this.#mode = mode;
    this.#redactor = redactor;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#size += chunk.length;
    if (this.#size > MAX_REDACTED_BODY_BYTES) {
      callback(new Error(TOO_LARGE));
      return;
    }
    this.#chunks.push(chunk);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    try {
      const body = Buffer.concat(this.#chunks);
      const redactor = this.#redactor();
      if (redactor.empty) {
        callback(null, body);
        return;
      }
      const text = body.toString('utf8');
      callback(null, this.#mode === 'json' ? redactor.json(text) : redactor.text(text));
    } catch (err) {
      callback(toError(err));
    }
  }
}

/** text/event-stream: each event when it is complete. Only the incomplete event waits in the buffer. */
class SseRedactor extends Transform {
  readonly #decoder = new TextDecoder('utf-8');
  readonly #redactor: () => Redactor;
  /** The start of a line without its end, in parts: one join when the line ends, so a long line costs linear time. */
  #pending: string[] = [];
  #pendingSize = 0;
  /** The last chunk ended with \r: a \n can follow in the next chunk. */
  #pendingCr = false;
  /** The lines of the current event, each with its line end. */
  #lines: string[] = [];
  #size = 0;

  constructor(redactor: () => Redactor) {
    super();
    this.#redactor = redactor;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      callback(null, this.#feed(this.#decoder.decode(chunk, { stream: true }), false));
    } catch (err) {
      callback(toError(err));
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      let out = this.#feed(this.#decoder.decode(), true);
      // An event without its blank line: clients discard it, but it is redacted too.
      if (this.#lines.length > 0) out += this.#event();
      const rest = this.#takePending('');
      if (rest !== '') out += this.#redactor().text(rest);
      callback(null, out);
    } catch (err) {
      callback(toError(err));
    }
  }

  #feed(input: string, final: boolean): string {
    let out = '';
    let start = 0;
    if (this.#pendingCr && (input.length > 0 || final)) {
      this.#pendingCr = false;
      const lineEnd = input.charCodeAt(0) === 10 ? '\r\n' : '\r';
      out += this.#line(this.#takePending(''), lineEnd);
      start = lineEnd.length - 1;
    }
    // Only the new input is scanned: the pending parts have no line end.
    for (let i = start; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      if (code === 13 && i + 1 === input.length && !final) {
        this.#pendingCr = true; // a \n can follow in the next chunk
        this.#addPending(input.slice(start, i));
        return this.#checkSize(out);
      }
      const end = code === 13 && input.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      out += this.#line(this.#takePending(input.slice(start, i)), input.slice(i, end));
      start = end;
      i = end - 1;
    }
    this.#addPending(input.slice(start));
    return this.#checkSize(out);
  }

  #line(line: string, lineEnd: string): string {
    if (line === '') return this.#event() + lineEnd;
    if (this.#lines.length === 0 && line.startsWith(':')) {
      return this.#redactor().text(line) + lineEnd; // a comment outside an event: no delay
    }
    this.#lines.push(line + lineEnd);
    this.#size += line.length + lineEnd.length;
    return '';
  }

  #addPending(part: string): void {
    if (part === '') return;
    this.#pending.push(part);
    this.#pendingSize += part.length;
  }

  #takePending(tail: string): string {
    if (this.#pending.length === 0) return tail;
    this.#pending.push(tail);
    const line = this.#pending.join('');
    this.#pending = [];
    this.#pendingSize = 0;
    return line;
  }

  #checkSize(out: string): string {
    if (this.#size + this.#pendingSize > MAX_REDACTED_BODY_BYTES) throw new Error(TOO_LARGE);
    return out;
  }

  #event(): string {
    const lines = this.#lines;
    this.#lines = [];
    this.#size = 0;
    const redactor = this.#redactor();
    if (redactor.empty) return lines.join('');
    const dataLines = new Set<number>();
    const data: string[] = [];
    lines.forEach((line, index) => {
      const content = line.replace(/\r\n$|\n$|\r$/, '');
      if (content !== 'data' && !content.startsWith('data:')) return;
      let value = content.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      dataLines.add(index);
      data.push(value);
    });
    if (data.length === 0) return lines.map((line) => redactor.text(line)).join('');
    const redacted = redactor.json(data.join('\n'));
    const first = dataLines.values().next().value;
    return lines
      .map((line, index) => {
        if (index === first)
          return redacted
            .split('\n')
            .map((part) => `data: ${part}\n`)
            .join('');
        return dataLines.has(index) ? '' : redactor.text(line);
      })
      .join('');
  }
}

export function createRedactionTransform(mode: BodyMode, redactor: () => Redactor): Transform {
  return mode === 'sse' ? new SseRedactor(redactor) : new BodyRedactor(mode, redactor);
}
