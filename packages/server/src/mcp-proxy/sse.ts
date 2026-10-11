// Incremental parser for text/event-stream (WHATWG HTML, "Parsing an event stream").

export interface SseEvent {
  event: string;
  data: string;
  id: string | null;
}

export const DEFAULT_MAX_EVENT_CHARS = 64 * 1024 * 1024;
const NUL = String.fromCharCode(0);

export class SseParser {
  readonly #decoder = new TextDecoder('utf-8');
  readonly #maxEventChars: number;
  #started = false;
  #skipLineFeed = false;
  #partialLine = '';
  #eventType = '';
  #data = '';
  #hasData = false;
  #lastEventId: string | null = null;
  #overflowed = false;

  constructor(options: { maxEventChars?: number } = {}) {
    this.#maxEventChars = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
  }

  /** True after one event was larger than maxEventChars. The parser then ignores all input. */
  get overflowed(): boolean {
    return this.#overflowed;
  }

  push(chunk: Uint8Array | string): SseEvent[] {
    if (this.#overflowed) return [];
    const text = typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    return this.#feed(text);
  }

  /** Call at the end of the stream. An event without its final blank line is discarded (as the spec says). */
  end(): SseEvent[] {
    if (this.#overflowed) return [];
    const events = this.#feed(this.#decoder.decode());
    this.#partialLine = '';
    this.#data = '';
    this.#hasData = false;
    this.#eventType = '';
    return events;
  }

  #feed(input: string): SseEvent[] {
    const events: SseEvent[] = [];
    let text = input;
    if (!this.#started) {
      if (text.length === 0) return events;
      this.#started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    if (this.#skipLineFeed && text.length > 0) {
      this.#skipLineFeed = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code !== 10 && code !== 13) continue;
      const line = this.#partialLine + text.slice(start, i);
      this.#partialLine = '';
      if (code === 13) {
        if (i + 1 < text.length) {
          if (text.charCodeAt(i + 1) === 10) i++;
        } else {
          this.#skipLineFeed = true;
        }
      }
      start = i + 1;
      const event = this.#line(line);
      if (event) events.push(event);
      if (this.#overflowed) return events;
    }
    this.#partialLine += text.slice(start);
    if (this.#partialLine.length + this.#data.length > this.#maxEventChars) this.#overflow();
    return events;
  }

  #line(line: string): SseEvent | null {
    if (line === '') return this.#dispatch();
    if (line.charCodeAt(0) === 58) return null; // ':' comment
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#eventType = value;
        break;
      case 'data':
        this.#data += value + '\n';
        this.#hasData = true;
        if (this.#data.length > this.#maxEventChars) this.#overflow();
        break;
      case 'id':
        if (!value.includes(NUL)) this.#lastEventId = value;
        break;
      default:
        break; // 'retry' and unknown fields do not matter for the audit copy
    }
    return null;
  }

  #dispatch(): SseEvent | null {
    const hasData = this.#hasData;
    const data = this.#data.endsWith('\n') ? this.#data.slice(0, -1) : this.#data;
    const event = this.#eventType === '' ? 'message' : this.#eventType;
    this.#data = '';
    this.#hasData = false;
    this.#eventType = '';
    if (!hasData) return null;
    return { event, data, id: this.#lastEventId };
  }

  #overflow(): void {
    this.#overflowed = true;
    this.#partialLine = '';
    this.#data = '';
  }
}
