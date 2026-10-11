import { describe, expect, it } from 'vitest';
import { parseSseData } from './sse.js';

describe('parseSseData', () => {
  it('returns the data of each event', () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{}}\n\n';
    expect(parseSseData(body)).toEqual([
      '{"jsonrpc":"2.0","id":1,"result":{}}',
      '{"jsonrpc":"2.0","id":2,"result":{}}',
    ]);
  });

  it('joins multi-line data, accepts CRLF, and skips comments and empty events', () => {
    const body = ': ping\r\n\r\nid: 7\r\ndata: line one\r\ndata:line two\r\n\r\n';
    expect(parseSseData(body)).toEqual(['line one\nline two']);
  });
});
