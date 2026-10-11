import { describe, expect, it } from 'vitest';
import { SseParser } from './sse.js';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const BOM = String.fromCharCode(0xfeff);
const NUL = String.fromCharCode(0);

describe('SseParser', () => {
  it('parses the framing of Playwright MCP', () => {
    const parser = new SseParser();
    const events = parser.push(
      encode('event: message\ndata: {"result":{},"jsonrpc":"2.0","id":1}\n\n'),
    );
    expect(events).toEqual([
      { event: 'message', data: '{"result":{},"jsonrpc":"2.0","id":1}', id: null },
    ]);
  });

  it('parses events that arrive in many chunks', () => {
    const parser = new SseParser();
    const text = 'event: message\ndata: {"a":1}\n\nevent: message\ndata: {"b":2}\n\n';
    const events = Array.from(encode(text)).flatMap((byte) => parser.push(Uint8Array.of(byte)));
    expect(events.map((event) => event.data)).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('decodes a multi-byte character that is split between two chunks', () => {
    const parser = new SseParser();
    const all = encode('data: grüße 😀\n\n');
    const events = [
      ...parser.push(all.slice(0, 9)),
      ...parser.push(all.slice(9, 15)),
      ...parser.push(all.slice(15)),
    ];
    expect(events).toEqual([{ event: 'message', data: 'grüße 😀', id: null }]);
  });

  it('accepts LF, CRLF, and CR line ends, also a CRLF that is split between chunks', () => {
    const parser = new SseParser();
    const events = [
      ...parser.push('data: one\r\n\r\ndata: two\r'),
      ...parser.push('\n\r'),
      ...parser.push('\ndata: three\r\rdata: four\n\n'),
    ];
    expect(events.map((event) => event.data)).toEqual(['one', 'two', 'three', 'four']);
  });

  it('joins data lines with LF and ignores comments, retry, and unknown fields', () => {
    const parser = new SseParser();
    const events = parser.push(
      ': keep-alive\nretry: 1000\nfoo: bar\ndata: line 1\ndata:line 2\ndata\n\n',
    );
    expect(events).toEqual([{ event: 'message', data: 'line 1\nline 2\n', id: null }]);
  });

  it('reads the event type and keeps the last event id for the next events', () => {
    const parser = new SseParser();
    const events = parser.push(
      `id: 7\nevent: custom\ndata: x\n\ndata: y\n\nid: bad${NUL}\ndata: z\n\n`,
    );
    expect(events).toEqual([
      { event: 'custom', data: 'x', id: '7' },
      { event: 'message', data: 'y', id: '7' },
      { event: 'message', data: 'z', id: '7' },
    ]);
  });

  it('does not dispatch a block without data lines', () => {
    const parser = new SseParser();
    expect(parser.push('event: message\n\n: comment\n\n')).toEqual([]);
  });

  it('removes a byte order mark at the start of the stream only', () => {
    const parser = new SseParser();
    expect(parser.push(`${BOM}data: a\n\n`)).toEqual([{ event: 'message', data: 'a', id: null }]);
    expect(parser.push(`data: ${BOM}b\n\n`)).toEqual([
      { event: 'message', data: `${BOM}b`, id: null },
    ]);
  });

  it('discards an event without its final blank line at the end of the stream', () => {
    const parser = new SseParser();
    expect(parser.push('data: complete\n\ndata: incomplete\n')).toEqual([
      { event: 'message', data: 'complete', id: null },
    ]);
    expect(parser.end()).toEqual([]);
  });

  it('stops after an event that is larger than the limit', () => {
    const parser = new SseParser({ maxEventChars: 10 });
    expect(parser.push('data: 0123456789abc\n\n')).toEqual([]);
    expect(parser.overflowed).toBe(true);
    expect(parser.push('data: small\n\n')).toEqual([]);
  });

  it('also stops when one line without a line end grows over the limit', () => {
    const parser = new SseParser({ maxEventChars: 10 });
    parser.push('data: 0123');
    parser.push('456789');
    expect(parser.overflowed).toBe(true);
  });
});
